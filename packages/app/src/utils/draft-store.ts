import type { AsyncStorage } from "@solid-primitives/storage"

export type BlobReference = { id: string; url: string }

type Driver = {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  putBlob(blob: Blob): Promise<string>
  getBlob(id: string): Promise<Blob | null>
}

export type DraftStore = AsyncStorage & { putBlob(blob: Blob): Promise<BlobReference> }
const urls = new Map<string, string>()

function blobUrl(id: string, blob: Blob) {
  const existing = urls.get(id)
  if (existing) return existing
  const url = URL.createObjectURL(blob)
  urls.set(id, url)
  return url
}

async function blobID(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // crypto.subtle only exists in secure contexts (HTTPS or localhost). Served over plain http on a LAN
  // or Tailscale address it is undefined, and every attachment failed with "reading 'digest'". The ID
  // only has to be a stable content key, so fall back to a fast non-cryptographic hash there.
  if (!globalThis.crypto?.subtle) return contentHash(bytes)
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

// cyrb53-style 2x32-bit hash over the bytes, plus the length; prefixed so it can never equal a SHA-256 hex id
function contentHash(bytes: Uint8Array) {
  let h1 = 0xdeadbeef ^ bytes.length
  let h2 = 0x41c6ce57 ^ bytes.length
  for (const byte of bytes) {
    h1 = Math.imul(h1 ^ byte, 2654435761)
    h2 = Math.imul(h2 ^ byte, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return `nc-${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}-${bytes.length.toString(16)}`
}

export async function createBlobReference(blob: Blob): Promise<BlobReference> {
  const id = await blobID(blob)
  return { id, url: blobUrl(id, blob) }
}

export function createDraftStore(driver: Driver): DraftStore {
  const versions = new Map<string, number>()
  const putBlob = async (blob: Blob) => {
    const id = await driver.putBlob(blob)
    return { id, url: blobUrl(id, blob) }
  }
  const encode = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(encode))
    if (!value || typeof value !== "object") return value
    const item = value as Record<string, unknown>
    if (item.type === "image" && typeof item.dataUrl === "string") {
      const blob = await fetch(item.dataUrl).then((response) => response.blob())
      const { dataUrl: _, ...rest } = item
      return { ...rest, blob: { id: await driver.putBlob(blob) } }
    }
    if ("blob" in item && item.blob && typeof item.blob === "object") {
      const blob = item.blob as Record<string, unknown>
      if (typeof blob.id === "string" && blob.id.startsWith("data:")) {
        const data = await fetch(blob.id).then((response) => response.blob())
        return { ...item, blob: { id: await driver.putBlob(data) } }
      }
      return { ...item, blob: { id: blob.id } }
    }
    return Object.fromEntries(
      await Promise.all(Object.entries(item).map(async ([key, entry]) => [key, await encode(entry)])),
    )
  }
  const decode = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(decode))
    if (!value || typeof value !== "object") return value
    const item = value as Record<string, unknown>
    if (item.blob && typeof item.blob === "object") {
      const ref = item.blob as Record<string, unknown>
      if (typeof ref.id === "string") {
        const blob = await driver.getBlob(ref.id)
        if (blob) return { ...item, blob: { id: ref.id, url: blobUrl(ref.id, blob) } }
      }
    }
    return Object.fromEntries(
      await Promise.all(Object.entries(item).map(async ([key, entry]) => [key, await decode(entry)])),
    )
  }
  return {
    getItem: async (key) => {
      const value = await driver.get(key)
      return value === null ? null : JSON.stringify(await decode(JSON.parse(value)))
    },
    setItem: async (key, value) => {
      const version = (versions.get(key) ?? 0) + 1
      versions.set(key, version)
      const encoded = JSON.stringify(await encode(JSON.parse(value)))
      if (versions.get(key) === version) await driver.set(key, encoded)
    },
    removeItem: async (key) => {
      versions.set(key, (versions.get(key) ?? 0) + 1)
      await driver.remove(key)
    },
    putBlob,
  }
}

export function createBrowserDraftStore(): DraftStore {
  const request = indexedDB.open("opencode-drafts", 1)
  request.addEventListener("upgradeneeded", () => {
    request.result.createObjectStore("documents")
    request.result.createObjectStore("blobs")
  })
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener("success", () => {
      const database = request.result
      const transaction = database.transaction(["documents", "blobs"], "readwrite")
      const documents = transaction.objectStore("documents").getAll()
      documents.addEventListener("success", () => {
        const used = new Set<string>()
        JSON.parse(`[${documents.result.join(",")}]`, (_key, item) => {
          if (item?.blob && typeof item.blob.id === "string") used.add(item.blob.id)
          return item
        })
        const blobs = transaction.objectStore("blobs").openKeyCursor()
        blobs.addEventListener("success", () => {
          const cursor = blobs.result
          if (!cursor) return
          if (!used.has(String(cursor.key))) cursor.delete()
          cursor.continue()
        })
      })
      transaction.addEventListener("complete", () => resolve(database))
      transaction.addEventListener("abort", () => resolve(database))
    })
    request.addEventListener("error", () => reject(request.error))
  })
  const get = async (store: string, key: string) => {
    const result = (await db).transaction(store).objectStore(store).get(key)
    return new Promise<unknown>((resolve, reject) => {
      result.addEventListener("success", () => resolve(result.result))
      result.addEventListener("error", () => reject(result.error))
    })
  }
  const write = async (store: string, key: string, value?: unknown) => {
    const transaction = (await db).transaction(store, "readwrite")
    if (value === undefined) transaction.objectStore(store).delete(key)
    else transaction.objectStore(store).put(value, key)
    return new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve())
      transaction.addEventListener("error", () => reject(transaction.error))
    })
  }
  return createDraftStore({
    get: async (key) => ((await get("documents", key)) as string | undefined) ?? null,
    set: (key, value) => write("documents", key, value),
    remove: (key) => write("documents", key),
    putBlob: async (blob) => {
      const id = await blobID(blob)
      await write("blobs", id, blob)
      return id
    },
    getBlob: async (id) => ((await get("blobs", id)) as Blob | undefined) ?? null,
  })
}

export async function blobDataUrl(blob: BlobReference, mime: string) {
  const data = await fetch(blob.url).then((response) => response.blob())
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener("error", () => reject(reader.error))
    reader.addEventListener("load", () => {
      const value = typeof reader.result === "string" ? reader.result : ""
      resolve(`data:${mime};base64,${value.slice(value.indexOf(",") + 1)}`)
    })
    reader.readAsDataURL(data)
  })
}

export function createLegacyBlobReference(dataUrl: string): BlobReference {
  return { id: dataUrl, url: dataUrl }
}

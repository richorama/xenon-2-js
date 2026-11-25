export const ASSET_BUNDLE_NAME = "game-assets.bin";

const VERSION = 1;
const byteTypes = { Uint8Array, Int8Array };

function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

export function encodeAssetBundle(data) {
  const ids = new Map(), nodes = [];
  function encode(value) {
    if (value === undefined) return [];
    if (value === null || typeof value !== "object") return value;
    if (ids.has(value)) return [ids.get(value)];
    const id = nodes.length;
    ids.set(value, id);
    nodes.push(null);
    if (Array.isArray(value)) nodes[id] = ["array", value.map(encode)];
    else if (value instanceof Map) nodes[id] = ["map", [...value].map(([key, item]) => [encode(key), encode(item)])];
    else if (value instanceof Uint16Array) nodes[id] = ["words", Array.from(value)];
    else if (Object.hasOwn(byteTypes, value.constructor.name)) {
      nodes[id] = [value.constructor.name, base64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
    } else if (Object.getPrototypeOf(value) === Object.prototype) {
      nodes[id] = ["object", Object.entries(value).map(([key, item]) => [key, encode(item)])];
    } else throw new Error(`Unsupported asset data: ${value.constructor.name}`);
    return [id];
  }
  return JSON.stringify([VERSION, encode(data), nodes]);
}

export function decodeAssetBundle(text) {
  const [version, root, nodes] = JSON.parse(text);
  if (version !== VERSION || !Array.isArray(nodes)) throw new Error("Unsupported game asset bundle");
  const objects = new Map();
  function decode(value) {
    if (!Array.isArray(value)) return value;
    if (!value.length) return undefined;
    const [id] = value;
    if (objects.has(id)) return objects.get(id);
    const [kind, data] = nodes[id] ?? [];
    let restored;
    switch (kind) {
      case "array":
        restored = [];
        objects.set(id, restored);
        for (const item of data) restored.push(decode(item));
        return restored;
      case "map":
        restored = new Map();
        objects.set(id, restored);
        for (const [key, item] of data) restored.set(decode(key), decode(item));
        return restored;
      case "object":
        restored = {};
        objects.set(id, restored);
        for (const [key, item] of data) {
          Object.defineProperty(restored, key, {
            value: decode(item), enumerable: true, writable: true, configurable: true,
          });
        }
        return restored;
      case "words":
        restored = Uint16Array.from(data);
        break;
      default:
        if (!Object.hasOwn(byteTypes, kind)) throw new Error("Invalid game asset bundle");
        const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
        restored = new byteTypes[kind](bytes.buffer);
    }
    objects.set(id, restored);
    return restored;
  }
  return decode(root);
}

export async function loadAssetBundle(url) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not load game asset bundle: HTTP ${response.status}`);
  const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
  return decodeAssetBundle(await new Response(stream).text());
}

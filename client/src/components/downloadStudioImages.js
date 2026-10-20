// ZIP with stored (unmodified) originals; no image encoding and no external dependency.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
function header(length, values) {
  const bytes = new Uint8Array(length),
    view = new DataView(bytes.buffer);
  for (const [offset, size, value] of values)
    view[size === 4 ? "setUint32" : "setUint16"](offset, value, true);
  return bytes;
}
export function originalZip(files) {
  const local = [],
    directory = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name),
      bytes = file.bytes,
      crc = crc32(bytes);
    const h = header(30, [
      [0, 4, 0x04034b50],
      [4, 2, 20],
      [6, 2, 0x800],
      [14, 4, crc],
      [18, 4, bytes.length],
      [22, 4, bytes.length],
      [26, 2, name.length],
    ]);
    local.push(h, name, bytes);
    directory.push(
      header(46, [
        [0, 4, 0x02014b50],
        [4, 2, 20],
        [6, 2, 20],
        [8, 2, 0x800],
        [16, 4, crc],
        [20, 4, bytes.length],
        [24, 4, bytes.length],
        [28, 2, name.length],
        [42, 4, offset],
      ]),
      name,
    );
    offset += 30 + name.length + bytes.length;
  }
  const size = directory.reduce((n, b) => n + b.length, 0);
  return new Blob(
    [
      ...local,
      ...directory,
      header(22, [
        [0, 4, 0x06054b50],
        [8, 2, files.length],
        [10, 2, files.length],
        [12, 4, size],
        [16, 4, offset],
      ]),
    ],
    { type: "application/zip" },
  );
}
export async function downloadOriginals(files) {
  const saved = [],
    failures = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(2, files.length) }, async () => {
      while (cursor < files.length) {
        const index = cursor++,
          file = files[index];
        try {
          const response = await fetch(`/${file.image_path}?download=1`);
          if (!response.ok) throw new Error();
          const bytes = new Uint8Array(await response.arrayBuffer());
          saved.push({
            index,
            name: `${String(index + 1).padStart(2, "0")}-${file.image_path.split("/").pop()}`,
            bytes,
          });
        } catch {
          failures.push(file.image_path);
        }
      }
    }),
  );
  if (!saved.length) throw new Error("原图均不可用，请稍后重试");
  saved.sort((a, b) => a.index - b.index);
  const url = URL.createObjectURL(originalZip(saved)),
    a = document.createElement("a");
  a.href = url;
  a.download = `款式原图-${Date.now()}.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { count: saved.length, failed: failures.length };
}

export default function OriginalImageLink({ path }) {
  if (!path) return null;
  return (
    <a
      className="btn secondary small original-image-download"
      href={`/${path}?download=1`}
      download
      onClick={(e) => e.stopPropagation()}
    >
      下载原图
    </a>
  );
}

// Run with writers stopped: node server/scripts/backup-style-upgrade.js DATA_DIR DESTINATION
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
const source = path.resolve(process.argv[2] || ""),
  destination = path.resolve(process.argv[3] || "");
if (
  process.argv.length !== 4 ||
  destination === source ||
  destination.startsWith(source + path.sep)
)
  throw new Error(
    "Provide DATA_DIR and a new backup directory outside DATA_DIR; stop the service first.",
  );
if (!fs.existsSync(path.join(source, "fashion-studio.db")))
  throw new Error("Source database does not exist");
if (fs.existsSync(destination))
  throw new Error("Backup destination already exists");
fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
const db = new Database(path.join(source, "fashion-studio.db"), {
  readonly: true,
});
try {
  await db.backup(path.join(destination, "fashion-studio.db"));
  if (fs.existsSync(path.join(source, "uploads")))
    fs.cpSync(path.join(source, "uploads"), path.join(destination, "uploads"), {
      recursive: true,
      dereference: false,
    });
  const check = new Database(path.join(destination, "fashion-studio.db"), {
    readonly: true,
  });
  try {
    if (check.pragma("integrity_check", { simple: true }) !== "ok")
      throw new Error("Backup integrity check failed");
  } finally {
    check.close();
  }
  fs.writeFileSync(
    path.join(destination, "manifest.json"),
    JSON.stringify(
      {
        created_at: new Date().toISOString(),
        database: "fashion-studio.db",
        uploads: fs.existsSync(path.join(destination, "uploads")),
      },
      null,
      2,
    ),
  );
  console.log("Database and upload snapshot verified.");
} finally {
  db.close();
}

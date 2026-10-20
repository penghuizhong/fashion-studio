// Includes historical references: deleting a source card must never unlink a production baseline.
export function productFileReferenced(db,file) {
 return !!db.prepare('SELECT 1 FROM product_file_refs WHERE path=? LIMIT 1').get(file);
}
export function productFileOwned(db,file,userId) {
 return !!db.prepare(`SELECT 1 FROM product_files WHERE user_id=? AND (path=? OR thumb_path=?)
  UNION ALL SELECT 1 FROM product_file_refs f JOIN product_records r ON r.id=f.record_id WHERE f.path=? AND (f.user_id=? OR (r.state='published' AND r.lifecycle='active' AND r.kind IN ('knowledge','standard','size_table','grading') AND EXISTS(SELECT 1 FROM product_history h WHERE h.record_id=f.record_id AND h.revision=f.revision AND h.state='published'))) LIMIT 1`).get(userId,file,file,file,userId);
}

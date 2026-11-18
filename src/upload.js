'use strict';
/**
 * Multipart form parser (zero dependencies).
 *
 * The browser sends the composer form as multipart/form-data. File parts
 * (video / photo) are streamed straight to disk — the whole file is never
 * held in memory — while text fields are collected as strings.
 *
 * The parser is a small state machine over a rolling buffer. For a file
 * part it always holds back the last (boundary length + 8) bytes so a
 * boundary split across two network chunks can never leak into the file.
 *
 * Usage:
 *   const { fields, files } = await parseMultipart(req, {
 *     destDir, maxFileSize, allowedExts
 *   });
 *   files = [{ field, filename, path, size, mime }]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function parseMultipart(req, options) {
  const opts = options || {};
  const maxFileSize = opts.maxFileSize || 1024 * 1024 * 1024; // 1 GB default
  const destDir = opts.destDir || path.join(__dirname, '..', 'data', 'uploads');
  fs.mkdirSync(destDir, { recursive: true });

  const contentType = req.headers['content-type'] || '';
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!m) return Promise.reject(new Error('Not a multipart request.'));
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());

  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const fileStreams = [];
    let buf = Buffer.alloc(0);
    let state = 'start'; // start | headers | data | done
    let part = null; // { name, filename, mime, fileStream, filePath, size }
    let finished = false;

    /** Wait until every file stream has flushed to disk. */
    function waitForFiles() {
      return Promise.all(fileStreams.map((s) => new Promise((res, rej) => {
        if (s.writableFinished) return res();
        s.once('finish', res);
        s.once('error', rej);
      })));
    }

    function fail(err) {
      if (finished) return;
      finished = true;
      if (part && part.fileStream) {
        try { part.fileStream.destroy(); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(part.filePath); } catch (_) { /* ignore */ }
      }
      reject(err);
    }

    function finishPartData(data) {
      // data is the complete body of the current part (without the boundary).
      if (!part) return;
      if (part.fileStream) {
        if (data.length) part.fileStream.write(data);
        part.fileStream.end();
      } else {
        fields[part.name] = (fields[part.name] || '') + data.toString('utf8');
      }
    }

    function startPart(headerText) {
      const disp = /Content-Disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerText);
      if (!disp) return null;
      const name = disp[1];
      const filename = disp[2] || null;
      const typeMatch = /Content-Type:\s*([^\r\n;]+)/i.exec(headerText);
      const mime = typeMatch ? typeMatch[1].trim() : 'application/octet-stream';
      if (filename) {
        const ext = path.extname(filename).toLowerCase() || '';
        const safe = crypto.randomBytes(8).toString('hex') + ext;
        const filePath = path.join(destDir, safe);
        const stream = fs.createWriteStream(filePath);
        fileStreams.push(stream);
        return {
          name, filename, mime, fileStream: stream, filePath, size: 0,
        };
      }
      return { name, filename: null, mime, fileStream: null, filePath: null, size: 0 };
    }

    function processBuffer() {
      while (true) {
        if (state === 'start') {
          const idx = buf.indexOf(boundary);
          if (idx === -1) {
            // Keep only the tail that could hold a split boundary.
            if (buf.length > boundary.length) buf = buf.subarray(buf.length - boundary.length);
            return;
          }
          buf = buf.subarray(idx + boundary.length);
          // After the first boundary comes either \r\n (more parts) or -- (end).
          if (buf.subarray(0, 2).equals(Buffer.from('--'))) {
            state = 'done';
            return;
          }
          if (buf.subarray(0, 2).equals(Buffer.from('\r\n'))) buf = buf.subarray(2);
          state = 'headers';
          part = null;
          continue;
        }

        if (state === 'headers') {
          const end = buf.indexOf(Buffer.from('\r\n\r\n'));
          if (end === -1) {
            if (buf.length > 8192) return fail(new Error('Part headers too large.'));
            return;
          }
          const headerText = buf.subarray(0, end).toString('utf8');
          buf = buf.subarray(end + 4);
          part = startPart(headerText);
          if (!part) return fail(new Error('Bad part headers.'));
          state = 'data';
          continue;
        }

        if (state === 'data') {
          // A part ends at \r\n + boundary.
          const needle = Buffer.concat([Buffer.from('\r\n'), boundary]);
          const idx = buf.indexOf(needle);
          if (idx !== -1) {
            const data = buf.subarray(0, idx);
            finishPartData(data);
            if (part.fileStream) {
              files.push({
                field: part.name,
                filename: part.filename,
                path: part.filePath,
                size: part.size + data.length,
                mime: part.mime,
              });
            }
            buf = buf.subarray(idx + needle.length);
            part = null;
            // After the boundary: "--" means the form is over.
            if (buf.subarray(0, 2).equals(Buffer.from('--'))) {
              state = 'done';
              return;
            }
            if (buf.subarray(0, 2).equals(Buffer.from('\r\n'))) buf = buf.subarray(2);
            state = 'headers';
            continue;
          }
          // No boundary yet: flush everything except a tail that could
          // hold a boundary split across chunks.
          const keep = needle.length + 4;
          if (buf.length > keep) {
            const chunk = buf.subarray(0, buf.length - keep);
            if (part.fileStream) {
              part.size += chunk.length;
              if (part.size > maxFileSize) {
                return fail(new Error('File is too big (over ' + Math.round(maxFileSize / 1048576) + ' MB).'));
              }
              part.fileStream.write(chunk);
            } else {
              fields[part.name] = (fields[part.name] || '') + chunk.toString('utf8');
            }
            buf = buf.subarray(buf.length - keep);
          }
          return;
        }

        if (state === 'done') return;
      }
    }

    req.on('data', (chunk) => {
      if (finished) return;
      buf = Buffer.concat([buf, chunk]);
      try { processBuffer(); } catch (e) { fail(e); }
    });
    req.on('end', () => {
      if (finished) return;
      try { processBuffer(); } catch (e) { return fail(e); }
      if (state !== 'done') {
        // The stream ended mid-part: flush what is left as data.
        if (state === 'data' && part) {
          finishPartData(buf);
          if (part.fileStream) {
            files.push({
              field: part.name,
              filename: part.filename,
              path: part.filePath,
              size: part.size + buf.length,
              mime: part.mime,
            });
          }
          buf = Buffer.alloc(0);
        }
      }
      finished = true;
      // Wait for file streams to flush to disk before handing the files back.
      waitForFiles().then(() => resolve({ fields, files })).catch((e) => reject(e));
    });
    req.on('error', (e) => fail(e));
  });
}

module.exports = { parseMultipart };

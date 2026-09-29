import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const [previousPath, currentPath, viewer = 'https://sqltoerdiagram.com/'] = process.argv.slice(2);
if (!previousPath || !currentPath || process.argv.length > 5) {
  console.error('Usage: node scripts/create-comparison-link.mjs previous.sql current.sql [viewer-url]');
  process.exit(1);
}

try {
  const project = {
    app: 'dbdiga',
    version: 2,
    mode: 'diff',
    dialect: 'postgres',
    previousSql: readFileSync(previousPath, 'utf8'),
    sql: readFileSync(currentPath, 'utf8'),
  };
  const encoded = deflateRawSync(Buffer.from(JSON.stringify(project), 'utf8')).toString('base64url');
  const url = new URL(viewer);
  url.hash = 's=z' + encoded;
  console.log(url.href);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

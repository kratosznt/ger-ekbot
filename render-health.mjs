
import { createServer } from 'node:http';

createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('KRATOS aktif');
}).listen(process.env.PORT || 10000, '0.0.0.0');

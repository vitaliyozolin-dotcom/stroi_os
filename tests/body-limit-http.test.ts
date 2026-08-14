import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import test from 'node:test';

const waitForPort = (child: ReturnType<typeof spawn>) => new Promise<number>((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error('body-limit server did not start')), 5_000);
  child.once('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`body-limit server exited before readiness: ${code}`));
  });
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
    const match = output.match(/READY (\d+)/);
    if (!match) return;
    clearTimeout(timer);
    resolve(Number(match[1]));
  });
});

const chunkedMultipart = (port: number) => new Promise<number>((resolve, reject) => {
  const boundary = 'stroios-body-limit-boundary';
  const prefix = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n`;
  const suffix = `\r\n--${boundary}--\r\n`;
  const request = httpRequest({
    hostname: '127.0.0.1',
    port,
    path: '/upload',
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Transfer-Encoding': 'chunked',
    },
  }, (response) => {
    response.resume();
    response.once('end', () => resolve(response.statusCode ?? 0));
  });
  request.once('error', reject);
  request.write(`${prefix}${'a'.repeat(650)}`);
  setTimeout(() => request.end(`${'b'.repeat(650)}${suffix}`), 10);
});

test('oversized chunked multipart returns 413 without terminating the HTTP process', async () => {
  const workerUrl = new URL('../sites/worker.js', import.meta.url).href;
  const program = `
    import { createServer } from 'node:http';
    import { Readable } from 'node:stream';
    import { requestWithBodyLimit } from ${JSON.stringify(workerUrl)};

    const server = createServer(async (incoming, outgoing) => {
      if (incoming.url === '/health') {
        outgoing.writeHead(200).end('ok');
        return;
      }
      try {
        const body = Readable.toWeb(incoming);
        const request = new Request('http://127.0.0.1/upload', {
          method: 'POST',
          headers: incoming.headers,
          body,
          duplex: 'half',
        });
        await requestWithBodyLimit(request, 1024).formData();
        outgoing.writeHead(204).end();
      } catch (error) {
        outgoing.writeHead(error?.message === 'payload_too_large' ? 413 : 400).end();
      }
    });
    server.listen(0, '127.0.0.1', () => console.log('READY ' + server.address().port));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  try {
    const port = await waitForPort(child);
    assert.equal(await chunkedMultipart(port), 413);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200, stderr);
    assert.equal(await health.text(), 'ok');
    assert.equal(child.exitCode, null, stderr);
  } finally {
    child.kill('SIGTERM');
  }
});

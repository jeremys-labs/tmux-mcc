import http from 'node:http';

export async function requestDiscordBridge(
  socketPath: string,
  path: string,
  payload: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const req = http.request({
      socketPath,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        if ((res.statusCode ?? 500) < 200 || (res.statusCode ?? 500) >= 300) {
          reject(new Error(responseBody));
          return;
        }
        resolve(responseBody);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

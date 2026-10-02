import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cli = require.resolve('@aloth/olcli/cli');
const { OverleafClient } = await import(pathToFileURL(path.join(path.dirname(cli), 'client.js')).href);
const [baseUrl, cookieName] = process.argv.slice(2);
try {
  const client = process.env.OVERLEAF_SESSION
    ? await OverleafClient.fromSessionCookie(process.env.OVERLEAF_SESSION, baseUrl, cookieName)
    : await OverleafClient.fromPasswordLogin(process.env.OVERLEAF_EMAIL, process.env.OVERLEAF_PASSWORD, baseUrl);
  const projects = await client.listProjects();
  const session = process.env.OVERLEAF_SESSION
    ? { name: cookieName, value: process.env.OVERLEAF_SESSION }
    : client.getSessionCookiePair(cookieName);
  if (!session) throw new Error('Login returned no session cookie');
  process.stdout.write(JSON.stringify({ projects, session }));
} catch (error) {
  process.stderr.write(error.message);
  process.exitCode = 1;
}

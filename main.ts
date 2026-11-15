// Entry point: the conversation between this process and the trial env.
//
// The env owns the trial. This process only has to do three things, in order:
//   1. Start the forge server on a port the kernel picks (never a fixed one:
//      8080 belongs to the env, and a fixed port would collide with it).
//   2. Tell the env which port that is, by POSTing {"port": N} to /register.
//      The env then dials this process at the address the request came from
//      plus N. If another entry registered first (409), that is not an error
//      for us — we simply keep waiting like everyone else.
//   3. Poll GET /done until the env answers {"done": true}, then shut the
//      server down and exit 0. Nothing here exits early: a failed poll is
//      retried forever, with a short backoff that grows to a 2 s cap.
//
// MAKEFUN_ENV_URL names the env's origin (http://store:8080 inside a trial
// container). Without it there is nothing to talk to, so we exit 1 at once.
//
// This file only wires the lifecycle. The forge itself lives in app.ts; no
// package, no Node built-in beyond fetch/setTimeout, no model call.

import { createApp } from './app.ts';

/** How long one register or done request may run before it is abandoned. */
const REQUEST_BUDGET_MS = 30_000;
/** First pause between retries, and the longest pause we will ever take. */
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;
/** The backoff exponent stops growing after this many failures. */
const BACKOFF_CAP = 8;

/** The env's origin, with any trailing slashes trimmed. */
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Pause after `failures` failed attempts: exponential from FIRST_PAUSE_MS, capped. */
function pauseAfter(failures: number): number {
  return Math.min(LONGEST_PAUSE_MS, FIRST_PAUSE_MS * 2 ** Math.min(failures, BACKOFF_CAP));
}

/**
 * Run `work` until it reports success. A `false` result means "not yet" and is
 * retried after the backoff; a thrown error is fatal and propagates to the
 * caller (and from there to the exit-1 handler at the bottom of this file).
 */
async function repeatUntilSettled(work: () => Promise<boolean>): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    if (await work()) return;
    await pause(pauseAfter(failures));
  }
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer and
 * 409 means a first register already won, which is fine. 400 and 405 are
 * contract errors and end the program; anything else (a network error, a
 * timeout, another status) just means the env is not ready yet, so retry.
 * Returns how many attempts the register took, for the startup log.
 */
async function announce(port: number): Promise<number> {
  let tries = 0;
  await repeatUntilSettled(async () => {
    tries += 1;
    let reply: Response;
    try {
      reply = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
    } catch {
      return false;
    }
    if (reply.status === 200 || reply.status === 409) return true;
    if (reply.status === 400 || reply.status === 405) {
      throw new Error(`register answered HTTP ${reply.status}: ${await reply.text()}`);
    }
    return false;
  });
  return tries;
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForFinish(): Promise<void> {
  await repeatUntilSettled(async () => {
    try {
      const reply = await fetch(`${envOrigin}/done`, { signal: AbortSignal.timeout(REQUEST_BUDGET_MS) });
      if (!reply.ok) return false;
      const payload = (await reply.json()) as { done?: unknown };
      return payload.done === true;
    } catch {
      // The env is not answering yet, or the poll timed out or came back
      // unreadable: it is not done, so poll again.
      return false;
    }
  });
}

/** Bind the forge, register it, then wait for the env: the whole life of the process. */
async function boot(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`[entry] listening on port ${port}\n`);

  const tries = await announce(port);
  if (tries > 1) process.stdout.write(`[entry] register took ${tries} attempts\n`);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForFinish();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

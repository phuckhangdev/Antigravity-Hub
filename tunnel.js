import { spawn } from 'child_process';
import readline from 'readline';

let tunnelProcess = null;
let tunnelUrl = null;
let tunnelStatus = 'stopped'; // 'stopped', 'starting', 'running', 'error'
let tunnelError = null;

export function startTunnel(port, useHttps = false) {
  return new Promise((resolve, reject) => {
    if (tunnelProcess) {
      return resolve({ url: tunnelUrl, status: tunnelStatus });
    }

    tunnelStatus = 'starting';
    tunnelError = null;

    const targetUrl = useHttps 
      ? `https://localhost:${port + 1}` 
      : `http://localhost:${port}`;
      
    const args = ['tunnel', '--url', targetUrl];
    if (useHttps) {
      args.push('--no-tls-verify');
    }

    console.log(`[TUNNEL] Starting cloudflared with target: ${targetUrl}`);
    
    // We use a custom PATH extension or try standard spawn
    tunnelProcess = spawn('cloudflared', args, {
      env: { ...process.env, PATH: '/usr/local/bin:/opt/homebrew/bin:' + process.env.PATH }
    });

    // Read cloudflared output (it outputs logs to stderr)
    const handleOutput = (stream) => {
      const rl = readline.createInterface({
        input: stream,
        crlfDelay: Infinity
      });

      rl.on('line', (line) => {
        // Log to console for debugging
        console.log(`[cloudflared] ${line}`);
        
        // Extract trycloudflare url
        const match = line.match(/https:\/\/[a-z0-9\-]+\.trycloudflare\.com/i);
        if (match) {
          tunnelUrl = match[0];
          tunnelStatus = 'running';
          console.log(`[TUNNEL] Established: ${tunnelUrl}`);
          if (!resolved) {
            resolved = true;
            resolve({ url: tunnelUrl, status: tunnelStatus });
          }
        }
      });
    };

    let resolved = false;
    handleOutput(tunnelProcess.stderr);
    handleOutput(tunnelProcess.stdout);

    // Timeout if tunnel takes too long to connect (e.g. 15 seconds)
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Cloudflare Tunnel connection timeout (15s). Ensure cloudflared is installed.'));
      }
    }, 15000);

    tunnelProcess.on('error', (err) => {
      clearTimeout(timeout);
      console.error('[TUNNEL] Failed to start cloudflared:', err);
      tunnelStatus = 'error';
      tunnelError = err.message;
      tunnelProcess = null;
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    tunnelProcess.on('close', (code) => {
      clearTimeout(timeout);
      console.log(`[TUNNEL] cloudflared process exited with code ${code}`);
      tunnelStatus = 'stopped';
      tunnelUrl = null;
      tunnelProcess = null;
    });
  });
}

export function stopTunnel() {
  if (tunnelProcess) {
    tunnelProcess.kill('SIGTERM');
    tunnelProcess = null;
    tunnelUrl = null;
    tunnelStatus = 'stopped';
    console.log('[TUNNEL] Cloudflare Tunnel stopped');
  }
}

export function getTunnelStatus() {
  return {
    status: tunnelStatus,
    url: tunnelUrl,
    error: tunnelError
  };
}

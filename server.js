import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { exec, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import readline from 'readline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// File paths for Agent interaction
const AGENT_INPUT_PATH = path.join(__dirname, 'agent_input.json');
const AGENT_STATUS_PATH = path.join(__dirname, 'agent_status.json');

// Ensure status file exists
if (!fs.existsSync(AGENT_STATUS_PATH)) {
  fs.writeFileSync(AGENT_STATUS_PATH, JSON.stringify({
    status: 'idle',
    current_step: 'Ready for commands',
    logs: []
  }, null, 2));
}

// Helper to parse top Mem/CPU output
function parseSize(str) {
  const match = str.match(/^([0-9.]+)([GMBK])$/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit === 'G') return val * 1024;
  if (unit === 'M') return val;
  if (unit === 'K') return val / 1024;
  return val;
}

// 1. System Metrics Gatherers
function getCpuUsage() {
  return new Promise((resolve) => {
    exec('top -l 1 -n 0 | grep "CPU usage"', (err, stdout) => {
      if (err || !stdout) return resolve(0);
      const match = stdout.match(/CPU usage:\s+([0-9.]+)%\s+user,\s+([0-9.]+)%\s+sys/i);
      if (match) {
        const user = parseFloat(match[1]);
        const sys = parseFloat(match[2]);
        return resolve(Math.round(user + sys));
      }
      resolve(0);
    });
  });
}

function getMemoryUsage() {
  return new Promise((resolve) => {
    exec('top -l 1 -n 0 | grep PhysMem', (err, stdout) => {
      if (err || !stdout) return resolve({ percent: 0, details: 'Unknown' });
      // PhysMem: 59G used (17G wired, 11G compressor), 4724M unused.
      const match = stdout.match(/PhysMem:\s+([0-9.]+[GMBK])\s+used.*,\s+([0-9.]+[GMBK])\s+unused/i);
      if (match) {
        const used = parseSize(match[1]);
        const unused = parseSize(match[2]);
        const total = used + unused;
        if (total > 0) {
          const percent = Math.round((used / total) * 100);
          const details = `${(used / 1024).toFixed(1)} GB / ${(total / 1024).toFixed(0)} GB used`;
          return resolve({ percent, details });
        }
      }
      resolve({ percent: 0, details: 'Unknown' });
    });
  });
}

function getBatteryInfo() {
  return new Promise((resolve) => {
    exec('pmset -g batt', (err, stdout) => {
      if (err || !stdout) return resolve({ percent: 0, charging: false, statusText: 'N/A' });
      const percentMatch = stdout.match(/([0-9]+)%/);
      const stateMatch = stdout.match(/;\s+([^;]+);/);
      
      const percent = percentMatch ? parseInt(percentMatch[1]) : 0;
      const charging = stdout.includes('charging') && !stdout.includes('not charging');
      const statusText = stateMatch ? stateMatch[1] : 'Unknown';
      resolve({ percent, charging, statusText });
    });
  });
}

// 2. AppleScript Executor Helper
function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err, stdout) => {
      if (err) return reject(err);
      resolve(stdout.trim());
    });
  });
}

// Broadcast system stats to all WS clients
async function broadcastStats() {
  const [cpu, mem, battery] = await Promise.all([
    getCpuUsage(),
    getMemoryUsage(),
    getBatteryInfo()
  ]);
  const statsMessage = JSON.stringify({
    type: 'stats',
    data: { cpu, mem, battery }
  });
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.isStatsSubscribed) {
      client.send(statsMessage);
    }
  });
}

// Poll stats every 3 seconds
setInterval(broadcastStats, 3000);

// Watch agent_status.json for updates to stream to clients
fs.watch(AGENT_STATUS_PATH, (eventType) => {
  if (eventType === 'change') {
    try {
      const data = JSON.parse(fs.readFileSync(AGENT_STATUS_PATH, 'utf8'));
      const statusMsg = JSON.stringify({
        type: 'agent_status',
        data
      });
      wss.clients.forEach((client) => {
        if (client.readyState === 1) {
          client.send(statusMsg);
        }
      });
    } catch (e) {
      // Ignore reading issues during fast writes
    }
  }
});

let activeTranscriptWatcher = null;
let activeConvoId = null;
let manualSelectionTime = 0;

function setupActiveTranscriptWatcher(force = false) {
  try {
    const brainDir = '/Users/phuckhangdev/.gemini/antigravity/brain';
    if (!fs.existsSync(brainDir)) return;

    const entries = fs.readdirSync(brainDir, { withFileTypes: true });
    let latestConvoId = null;
    let maxMtime = 0;

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const convoPath = path.join(brainDir, entry.name);
        const transcriptPath = path.join(convoPath, '.system_generated', 'logs', 'transcript.jsonl');
        
        if (fs.existsSync(transcriptPath)) {
          const stat = fs.statSync(transcriptPath);
          if (stat.mtimeMs > maxMtime) {
            maxMtime = stat.mtimeMs;
            latestConvoId = entry.name;
          }
        }
      }
    }

    if (!latestConvoId && !activeConvoId) return;

    let targetConvoId = activeConvoId;
    let shouldUpdateWatcher = force;

    if (!force) {
      if (!activeConvoId) {
        targetConvoId = latestConvoId;
        shouldUpdateWatcher = true;
      } else if (latestConvoId && latestConvoId !== activeConvoId) {
        // Only auto-switch if latest has changes after manualSelectionTime
        if (maxMtime > manualSelectionTime) {
          targetConvoId = latestConvoId;
          shouldUpdateWatcher = true;
        }
      }
    }

    if (shouldUpdateWatcher || !activeTranscriptWatcher) {
      if (activeTranscriptWatcher) {
        activeTranscriptWatcher.close();
        activeTranscriptWatcher = null;
      }
      
      activeConvoId = targetConvoId;
      const transcriptPath = path.join(brainDir, activeConvoId, '.system_generated', 'logs', 'transcript.jsonl');
      
      console.log(`[WATCHER] Watching active transcript: ${transcriptPath}`);
      
      let debounceTimeout = null;
      activeTranscriptWatcher = fs.watch(transcriptPath, (eventType) => {
        if (eventType === 'change') {
          if (debounceTimeout) clearTimeout(debounceTimeout);
          debounceTimeout = setTimeout(() => {
            const msg = JSON.stringify({
              type: 'transcript_update',
              activeConvoId
            });
            wss.clients.forEach((client) => {
              if (client.readyState === 1) {
                client.send(msg);
              }
            });
          }, 150);
        }
      });
    }
  } catch (error) {
    console.error('Error in setupActiveTranscriptWatcher:', error);
  }
}

// Initial setup
setupActiveTranscriptWatcher();

// Periodically scan for new conversations
setInterval(setupActiveTranscriptWatcher, 4000);

// WebSocket Connection Handler
wss.on('connection', (ws) => {
  console.log('Client connected from local network');
  ws.isStatsSubscribed = false;

  // Make sure watcher is active and updated
  setupActiveTranscriptWatcher();

  // Send initial agent status
  try {
    const data = JSON.parse(fs.readFileSync(AGENT_STATUS_PATH, 'utf8'));
    ws.send(JSON.stringify({ type: 'agent_status', data }));
  } catch (e) {}

  let terminalShell = null;

  ws.on('message', async (message) => {
    try {
      const parsed = JSON.parse(message);
      
      switch (parsed.type) {
        case 'subscribe_stats':
          ws.isStatsSubscribed = true;
          // Send immediately
          broadcastStats();
          break;

        case 'system_control':
          const { action } = parsed;
          let script = '';
          if (action === 'vol_up') {
            script = 'set volume output volume (output volume of (get volume settings) + 6)';
          } else if (action === 'vol_down') {
            script = 'set volume output volume (output volume of (get volume settings) - 6)';
          } else if (action === 'vol_mute') {
            script = 'set volume output muted not (output muted of (get volume settings))';
          } else if (action === 'play_pause') {
            script = `
              tell application "System Events"
                set spotifyRunning to (name of processes contains "Spotify")
                set musicRunning to (name of processes contains "Music")
              end tell
              if spotifyRunning then
                tell application "Spotify" to playpause
              else if musicRunning then
                tell application "Music" to playpause
              end tell
            `;
          } else if (action === 'next_track') {
            script = `
              tell application "System Events"
                set spotifyRunning to (name of processes contains "Spotify")
                set musicRunning to (name of processes contains "Music")
              end tell
              if spotifyRunning then
                tell application "Spotify" to next track
              else if musicRunning then
                tell application "Music" to next track
              end tell
            `;
          } else if (action === 'prev_track') {
            script = `
              tell application "System Events"
                set spotifyRunning to (name of processes contains "Spotify")
                set musicRunning to (name of processes contains "Music")
              end tell
              if spotifyRunning then
                tell application "Spotify" to previous track
              else if musicRunning then
                tell application "Music" to previous track
              end tell
            `;
          } else if (action === 'sleep') {
            script = 'tell application "System Events" to sleep';
          } else if (action === 'lock') {
            // Lock screen using display sleep (immediate lock on modern Mac)
            exec('pmset displaysleepnow');
            ws.send(JSON.stringify({ type: 'control_ack', action, success: true }));
            return;
          }

          if (script) {
            try {
              await runAppleScript(script);
              ws.send(JSON.stringify({ type: 'control_ack', action, success: true }));
            } catch (err) {
              console.error(`AppleScript Error for action ${action}:`, err);
              ws.send(JSON.stringify({ type: 'control_ack', action, success: false, error: err.message }));
            }
          }
          break;

        case 'terminal_init':
          if (terminalShell) {
            terminalShell.kill();
          }
          terminalShell = spawn('/bin/zsh', ['-l'], {
            env: { ...process.env, TERM: 'xterm-256color' }
          });

          terminalShell.stdout.on('data', (data) => {
            ws.send(JSON.stringify({ type: 'terminal_output', data: data.toString() }));
          });

          terminalShell.stderr.on('data', (data) => {
            ws.send(JSON.stringify({ type: 'terminal_output', data: data.toString() }));
          });

          terminalShell.on('close', () => {
            ws.send(JSON.stringify({ type: 'terminal_output', data: '\r\n[Shell exited]\r\n' }));
            terminalShell = null;
          });
          break;

        case 'terminal_input':
          if (terminalShell) {
            terminalShell.stdin.write(parsed.data);
          } else {
            ws.send(JSON.stringify({ type: 'terminal_output', data: 'No active shell session.\r\n' }));
          }
          break;

        case 'terminal_kill':
          if (terminalShell) {
            terminalShell.kill('SIGINT');
          }
          break;

        case 'agent_submit':
          const { prompt } = parsed;
          // Set agent_input.json
          fs.writeFileSync(AGENT_INPUT_PATH, JSON.stringify({
            prompt,
            timestamp: Date.now(),
            status: 'pending'
          }, null, 2));

          // Log status to busy
          fs.writeFileSync(AGENT_STATUS_PATH, JSON.stringify({
            status: 'busy',
            current_step: 'Submitting message to Antigravity...',
            logs: [`[Client] Submitting prompt: "${prompt}"`]
          }, null, 2));

          if (activeConvoId) {
            console.log(`[AGENT_SUBMIT] Sending to active conversation ${activeConvoId}: "${prompt}"`);
            const child = spawn('/Users/phuckhangdev/.gemini/antigravity/bin/agentapi', ['send-message', activeConvoId, prompt]);
            
            let stderrData = '';
            child.stderr.on('data', (data) => { stderrData += data.toString(); });
            
            child.on('close', (code) => {
              if (code === 0) {
                console.log(`[AGENT_SUBMIT] Message sent successfully via agentapi.`);
                fs.writeFileSync(AGENT_STATUS_PATH, JSON.stringify({
                  status: 'busy',
                  current_step: 'Antigravity agent processing...',
                  logs: [`[Client] Prompt sent successfully.`]
                }, null, 2));
              } else {
                console.error(`[AGENT_SUBMIT] Failed to send message. Exit code ${code}. Error: ${stderrData}`);
                fs.writeFileSync(AGENT_STATUS_PATH, JSON.stringify({
                  status: 'error',
                  current_step: 'Failed to send message to Antigravity',
                  logs: [`[Error] agentapi exited with code ${code}. Stderr: ${stderrData}`]
                }, null, 2));
              }
            });
          } else {
            console.log(`[AGENT_SUBMIT] No active conversation. Creating new conversation...`);
            const child = spawn('/Users/phuckhangdev/.gemini/antigravity/bin/agentapi', ['new-conversation', prompt]);
            
            let stderrData = '';
            child.stderr.on('data', (data) => { stderrData += data.toString(); });

            child.on('close', (code) => {
              if (code === 0) {
                console.log(`[AGENT_SUBMIT] New conversation created successfully via agentapi.`);
                fs.writeFileSync(AGENT_STATUS_PATH, JSON.stringify({
                  status: 'busy',
                  current_step: 'Antigravity agent processing...',
                  logs: [`[Client] New conversation created successfully.`]
                }, null, 2));
              } else {
                console.error(`[AGENT_SUBMIT] Failed to create new conversation. Exit code ${code}. Error: ${stderrData}`);
                fs.writeFileSync(AGENT_STATUS_PATH, JSON.stringify({
                  status: 'error',
                  current_step: 'Failed to create new conversation',
                  logs: [`[Error] agentapi exited with code ${code}. Stderr: ${stderrData}`]
                }, null, 2));
              }
            });
          }

          setTimeout(setupActiveTranscriptWatcher, 100);
          break;

        default:
          console.log('Unknown message type:', parsed.type);
      }
    } catch (e) {
      console.error('Error handling WebSocket message:', e);
    }
  });

  ws.on('close', () => {
    if (terminalShell) {
      terminalShell.kill();
    }
  });
});

// Helper to extract conversation metadata from first user request and user_information in transcript.jsonl
async function getConversationMetadata(convoPath) {
  const transcriptPath = path.join(convoPath, '.system_generated', 'logs', 'transcript.jsonl');
  const metadata = {
    title: 'Untitled Conversation',
    project: 'Unknown Project'
  };
  
  if (!fs.existsSync(transcriptPath)) {
    return metadata;
  }
  
  function extractProjectFromPath(filePath) {
    try {
      let cleanPath = decodeURIComponent(filePath);
      cleanPath = cleanPath.replace(/[.,;:\`\)\}\]"'\s]+$/, '');
      if (cleanPath.includes('/.gemini/')) {
        return null;
      }
      const match = cleanPath.match(/\/Users\/[^\/]+\/(projects|Documents\/antigravity|Documents)\/([^\/]+)/i);
      if (match) {
        return match[2];
      }
      const fallbackMatch = cleanPath.match(/\/Users\/[^\/]+\/([^\/]+)\/([^\/]+)/i);
      if (fallbackMatch) {
        const parent = fallbackMatch[1];
        const child = fallbackMatch[2];
        if (parent !== '.gemini' && parent !== '.config') {
          return child;
        }
      }
    } catch (e) {}
    return null;
  }

  try {
    const fileStream = fs.createReadStream(transcriptPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    let titleFound = false;
    let projectFound = false;
    
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const content = parsed.content || '';
        
        // 1. Try to find project mapping from user_information
        if (!projectFound && content.includes('<user_information>')) {
          const workspaceMatch = content.match(/\/Users\/[^\/]+\/([^\n\r]+?)(?:\s+->|\s+|$)/i);
          if (workspaceMatch) {
            const projectPath = workspaceMatch[1].trim();
            const parts = projectPath.split('/');
            const projName = parts[parts.length - 1] || parts[parts.length - 2];
            if (projName && !projName.includes('.gemini')) {
              metadata.project = projName;
              projectFound = true;
            }
          }
        }
        
        // 2. Try to find project from any path in the content
        if (!projectFound) {
          const paths = content.match(/\/Users\/[^\/]+\/[^\s"'\`]+/g);
          if (paths) {
            for (const p of paths) {
              const proj = extractProjectFromPath(p);
              if (proj) {
                metadata.project = proj;
                projectFound = true;
                break;
              }
            }
          }
        }
        
        // 3. Try to find user request for title
        if (!titleFound && (parsed.source === 'USER_EXPLICIT' || parsed.type === 'USER_INPUT')) {
          const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
          if (match && match[1].trim()) {
            metadata.title = match[1].trim();
            titleFound = true;
          } else if (content.trim()) {
            metadata.title = content.replace(/<[^>]*>/g, '').trim();
            titleFound = true;
          }
          if (metadata.title.length > 80) {
            metadata.title = metadata.title.substring(0, 80) + '...';
          }
        }
        
        if (titleFound && projectFound) {
          break;
        }
      } catch (e) {}
    }
    rl.close();
  } catch (err) {
    console.error('Error reading metadata:', err);
  }
  return metadata;
}

// REST API Endpoints for Workspace Monitoring
app.get('/api/projects', async (req, res) => {
  try {
    const parentDir = '/Users/phuckhangdev/Documents/antigravity';
    const entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
    const projects = [];
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const projectPath = path.join(parentDir, entry.name);
        const stat = await fs.promises.stat(projectPath);
        
        // Get git branch
        const branch = await new Promise((resolve) => {
          exec('git branch --show-current', { cwd: projectPath }, (err, stdout) => {
            if (err) return resolve('');
            resolve(stdout.trim());
          });
        });
        
        projects.push({
          name: entry.name,
          path: projectPath,
          branch: branch || 'none',
          mtime: stat.mtimeMs
        });
      }
    }
    
    // Sort by mtime descending
    projects.sort((a, b) => b.mtime - a.mtime);
    res.json(projects);
  } catch (error) {
    console.error('Error fetching projects:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations', async (req, res) => {
  try {
    const brainDir = '/Users/phuckhangdev/.gemini/antigravity/brain';
    if (!fs.existsSync(brainDir)) {
      return res.json([]);
    }
    
    const entries = await fs.promises.readdir(brainDir, { withFileTypes: true });
    const conversations = [];
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const convoPath = path.join(brainDir, entry.name);
        const transcriptPath = path.join(convoPath, '.system_generated', 'logs', 'transcript.jsonl');
        
        if (fs.existsSync(transcriptPath)) {
          const stat = await fs.promises.stat(transcriptPath);
          conversations.push({
            id: entry.name,
            path: convoPath,
            mtime: stat.mtimeMs
          });
        }
      }
    }
    
    // Sort by mtime descending
    conversations.sort((a, b) => b.mtime - a.mtime);
    
    // Slice top 15
    const topConversations = conversations.slice(0, 15);
    
    const result = [];
    for (const convo of topConversations) {
      const meta = await getConversationMetadata(convo.path);
      result.push({
        id: convo.id,
        title: meta.title,
        project: meta.project,
        date: convo.mtime
      });
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/conversations/active - Find the active conversation (most recently modified log)
app.get('/api/conversations/active', async (req, res) => {
  try {
    const brainDir = '/Users/phuckhangdev/.gemini/antigravity/brain';
    if (!fs.existsSync(brainDir)) {
      return res.status(404).json({ error: 'Brain directory not found' });
    }
    
    const entries = await fs.promises.readdir(brainDir, { withFileTypes: true });
    let activeConvoId = null;
    let maxMtime = 0;
    
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const convoPath = path.join(brainDir, entry.name);
        const transcriptPath = path.join(convoPath, '.system_generated', 'logs', 'transcript.jsonl');
        
        if (fs.existsSync(transcriptPath)) {
          const stat = await fs.promises.stat(transcriptPath);
          if (stat.mtimeMs > maxMtime) {
            maxMtime = stat.mtimeMs;
            activeConvoId = entry.name;
          }
        }
      }
    }
    
    if (!activeConvoId) {
      return res.status(404).json({ error: 'No active conversation found' });
    }
    
    res.json({ id: activeConvoId });
  } catch (error) {
    console.error('Error finding active conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/conversations/active - Manually activate a conversation
app.post('/api/conversations/active', (req, res) => {
  try {
    const { id } = req.body;
    if (!id) {
      return res.status(400).json({ error: 'Conversation ID is required' });
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return res.status(400).json({ error: 'Invalid conversation ID format' });
    }
    const brainDir = '/Users/phuckhangdev/.gemini/antigravity/brain';
    const transcriptPath = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    activeConvoId = id;
    manualSelectionTime = Date.now();
    setupActiveTranscriptWatcher(true); // force watcher setup
    
    res.json({ success: true, activeConvoId });
  } catch (error) {
    console.error('Error manually activating conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper to extract the selected model from the active transcript
async function detectActiveModel(convoId) {
  try {
    const brainDir = '/Users/phuckhangdev/.gemini/antigravity/brain';
    const transcriptPath = path.join(brainDir, convoId, '.system_generated', 'logs', 'transcript.jsonl');
    if (!fs.existsSync(transcriptPath)) return null;

    const fileStream = fs.createReadStream(transcriptPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let detectedModel = null;
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const content = parsed.content || '';
        // Look for settings change in content
        const match = content.match(/changed setting `Model Selection` from .*? to ([^.\n]+)/);
        if (match) {
          detectedModel = match[1].trim();
        }
      } catch (e) {}
    }
    rl.close();
    return detectedModel;
  } catch (err) {
    console.error('Error detecting active model:', err);
    return null;
  }
}

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const convoId = req.params.id;
    // Simple verification for UUID to avoid directory traversal
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(convoId)) {
      return res.status(400).json({ error: 'Invalid conversation ID format' });
    }
    
    const brainDir = '/Users/phuckhangdev/.gemini/antigravity/brain';
    const transcriptPath = path.join(brainDir, convoId, '.system_generated', 'logs', 'transcript.jsonl');
    
    if (!fs.existsSync(transcriptPath)) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    
    const fileStream = fs.createReadStream(transcriptPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    const steps = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.source === 'USER_EXPLICIT' || parsed.type === 'USER_INPUT') {
          const content = parsed.content || '';
          let text = content;
          const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
          if (match) {
            text = match[1].trim();
          } else {
            text = content.replace(/<[^>]*>/g, '').trim();
          }
          steps.push({
            sender: 'user',
            text: text,
            time: parsed.created_at || new Date().toISOString()
          });
        } else if (parsed.source === 'MODEL' && parsed.type === 'PLANNER_RESPONSE') {
          if (parsed.content && parsed.content.trim()) {
            steps.push({
              sender: 'agent',
              text: parsed.content.trim(),
              time: parsed.created_at || new Date().toISOString()
            });
          }
          
          // Check for tool calls like ask_question
          if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
            parsed.tool_calls.forEach(tc => {
              if (tc.name === 'ask_question') {
                try {
                  let args = tc.args;
                  if (typeof args === 'string') {
                    args = JSON.parse(args);
                  }
                  
                  let questionsVal = args.questions;
                  if (typeof questionsVal === 'string') {
                    questionsVal = JSON.parse(questionsVal);
                  }
                  
                  if (Array.isArray(questionsVal)) {
                    questionsVal.forEach(qObj => {
                      steps.push({
                        sender: 'agent-question',
                        question: qObj.question,
                        options: qObj.options,
                        isMultiSelect: qObj.is_multi_select,
                        time: parsed.created_at || new Date().toISOString()
                      });
                    });
                  }
                } catch (err) {
                  console.error('Error parsing ask_question args:', err);
                }
              }
            });
          }
        } else if (parsed.type === 'ASK_QUESTION') {
          // This is the user's answer to the ask_question tool
          const content = parsed.content || '';
          steps.push({
            sender: 'user-answer',
            text: content.trim(),
            time: parsed.created_at || new Date().toISOString()
          });
        }
      } catch (e) {}
    }
    rl.close();
    res.json({ steps });
  } catch (error) {
    console.error('Error fetching conversation transcript:', error);
    res.status(500).json({ error: error.message });
  }
});

const MODEL_CONFIG_PATH = path.join(__dirname, 'model_config.json');

// Initialize model config if not exists
if (!fs.existsSync(MODEL_CONFIG_PATH)) {
  fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify({
    models: [
      "Gemini 3.5 Flash (High)",
      "Claude Opus 4.6 (Thinking)",
      "Claude Sonnet 4.6 (Thinking)",
      "Gemini 3.1 Pro (High)"
    ],
    selectedModel: "Gemini 3.5 Flash (High)"
  }, null, 2));
} else {
  try {
    const data = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf8'));
    // Ensure all target models are listed
    const targetModels = [
      "Gemini 3.5 Flash (High)",
      "Claude Opus 4.6 (Thinking)",
      "Claude Sonnet 4.6 (Thinking)",
      "Gemini 3.1 Pro (High)"
    ];
    let hasAll = true;
    for (const m of targetModels) {
      if (!data.models || !data.models.includes(m)) {
        hasAll = false;
        break;
      }
    }
    if (!hasAll) {
      data.models = targetModels;
      data.selectedModel = "Gemini 3.5 Flash (High)";
      fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(data, null, 2));
    }
  } catch (e) {
    fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify({
      models: [
        "Gemini 3.5 Flash (High)",
        "Claude Opus 4.6 (Thinking)",
        "Claude Sonnet 4.6 (Thinking)",
        "Gemini 3.1 Pro (High)"
      ],
      selectedModel: "Gemini 3.5 Flash (High)"
    }, null, 2));
  }
}

// GET /api/model/config - Get current selected model and all available models
app.get('/api/model/config', async (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf8'));
    
    // Dynamically detect selected model from active transcript if possible
    if (activeConvoId) {
      const activeModel = await detectActiveModel(activeConvoId);
      if (activeModel) {
        if (!data.models.includes(activeModel)) {
          data.models.push(activeModel);
        }
        data.selectedModel = activeModel;
        fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(data, null, 2));
      }
    }
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// POST /api/model/select - Change the selected model
app.post('/api/model/select', (req, res) => {
  try {
    const { model } = req.body;
    if (!model) {
      return res.status(400).json({ error: 'Model name is required' });
    }
    const data = JSON.parse(fs.readFileSync(MODEL_CONFIG_PATH, 'utf8'));
    if (!data.models.includes(model)) {
      return res.status(400).json({ error: 'Invalid model selection' });
    }
    data.selectedModel = model;
    fs.writeFileSync(MODEL_CONFIG_PATH, JSON.stringify(data, null, 2));
    
    // Notify in stdout
    console.log(`[MODEL_CHANGE] ${model}`);
    
    res.json({ success: true, selectedModel: model });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start HTTP/WS server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(`Server is running locally at http://localhost:${PORT}`);
  
  // Find local IP addresses
  import('os').then((os) => {
    const interfaces = os.networkInterfaces();
    console.log(`Access remotely on your iPhone using:`);
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          console.log(`  👉 http://${iface.address}:${PORT}`);
        }
      }
    }
    console.log(`====================================================`);
  });
});

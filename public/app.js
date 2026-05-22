// Determine websocket address based on current page address
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}`;

let socket = null;
let reconnectInterval = 3000;
let statsSubscribed = false;

// Connect to websocket server
function connect() {
  updateConnectionStatus('connecting', 'Connecting...');
  
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log('Connected to server');
    updateConnectionStatus('connected', 'Connected');
    
    // Load model config initially
    loadModelConfig();

    // Subscribe to stats if the active tab is Monitor
    if (document.getElementById('panel-monitor').classList.contains('active')) {
      subscribeStats();
    }
    
    // Initialize terminal if Terminal tab is active
    if (document.getElementById('panel-terminal').classList.contains('active')) {
      initTerminal();
    }

    // Refresh active chat if Agent tab is active
    if (document.getElementById('panel-agent').classList.contains('active')) {
      refreshActiveChat().then(() => loadConversationsDropdown());
    }
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  };

  socket.onclose = () => {
    console.log('Connection closed, retrying...');
    updateConnectionStatus('disconnected', 'Offline (Retrying...)');
    statsSubscribed = false;
    setTimeout(connect, reconnectInterval);
  };

  socket.onerror = (err) => {
    console.error('Socket error:', err);
    socket.close();
  };
}

// Update UI Connection status badge
function updateConnectionStatus(state, text) {
  const badge = document.getElementById('connection-badge');
  const textEl = badge.querySelector('.status-text');
  
  badge.className = `connection-status ${state}`;
  textEl.textContent = text;
}

// Subscribe to system statistics
function subscribeStats() {
  if (socket && socket.readyState === WebSocket.OPEN && !statsSubscribed) {
    socket.send(JSON.stringify({ type: 'subscribe_stats' }));
    statsSubscribed = true;
  }
}

// Request media or system action
function sendControl(action) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'system_control',
      action
    }));
  } else {
    alert('Not connected to Mac server');
  }
}

// Handle all incoming socket payloads
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'stats':
      updateStatsUI(msg.data);
      break;
    case 'terminal_output':
      appendTerminalOutput(msg.data);
      break;
    case 'agent_status':
      updateAgentStatusUI(msg.data);
      refreshActiveChat();
      break;
    case 'transcript_update':
      refreshActiveChat(msg.activeConvoId);
      break;
    case 'control_ack':
      console.log(`Action ${msg.action} executed. Success: ${msg.success}`);
      break;
  }
}

// 1. Monitor Tab UI Updates
function updateStatsUI(data) {
  const { cpu, mem, battery } = data;
  
  // CPU Gauge Update
  const cpuRing = document.getElementById('cpu-ring');
  const cpuVal = document.getElementById('cpu-val');
  if (cpuRing && cpuVal) {
    cpuRing.style.setProperty('--val', `${cpu}%`);
    cpuRing.style.background = `radial-gradient(closest-side, var(--bg-color) 82%, transparent 0 99%), conic-gradient(var(--accent-blue) ${cpu}%, rgba(255, 255, 255, 0.05) 0)`;
    cpuVal.textContent = `${cpu}%`;
  }

  // RAM Memory Progress Bar Update
  const ramPercent = document.getElementById('ram-percent');
  const ramDetails = document.getElementById('ram-details');
  const ramFill = document.getElementById('ram-fill');
  if (ramPercent && ramDetails && ramFill) {
    ramPercent.textContent = `${mem.percent}%`;
    ramDetails.textContent = mem.details;
    ramFill.style.width = `${mem.percent}%`;
  }

  // Battery Status update
  const batFill = document.getElementById('bat-fill');
  const batPct = document.getElementById('bat-pct');
  const batState = document.getElementById('bat-state');
  const batBolt = document.getElementById('bat-bolt');
  if (batFill && batPct && batState && batBolt) {
    batFill.style.width = `${battery.percent}%`;
    
    // Color battery indicator based on levels
    if (battery.percent <= 20 && !battery.charging) {
      batFill.style.backgroundColor = 'var(--accent-red)';
    } else if (battery.percent <= 50) {
      batFill.style.backgroundColor = 'var(--accent-yellow)';
    } else {
      batFill.style.backgroundColor = 'var(--accent-green)';
    }

    batPct.textContent = `${battery.percent}%`;
    batState.textContent = battery.statusText;
    
    // Toggle battery charging bolt icon
    if (battery.charging) {
      batBolt.style.display = 'block';
    } else {
      batBolt.style.display = 'none';
    }
  }
}

// 2. Terminal Tab logic
const terminalOutput = document.getElementById('terminal-output');
const terminalInput = document.getElementById('terminal-input');

function initTerminal() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    terminalOutput.innerHTML = '<div class="terminal-log-row system">Starting shell session...</div>';
    socket.send(JSON.stringify({ type: 'terminal_init' }));
  }
}

function appendTerminalOutput(data) {
  // Convert ANSI escape sequences like newlines to standard HTML
  // Simple conversion of basic carriage returns and backspaces
  let cleanData = data
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
    
  const div = document.createElement('span');
  div.textContent = cleanData;
  terminalOutput.appendChild(div);
  
  // Keep terminal scrolled to bottom
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

function killTerminal() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'terminal_kill' }));
  }
}

if (terminalInput) {
  terminalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const val = terminalInput.value;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'terminal_input',
          data: val + '\n'
        }));
      }
      terminalInput.value = '';
    }
  });
}

// 3. Antigravity Agent Tab logic

// Model Config and Selector
async function loadModelConfig() {
  try {
    const res = await fetch('/api/model/config');
    const config = await res.json();
    const selector = document.getElementById('model-selector');
    if (selector) {
      if (config.models && Array.isArray(config.models)) {
        selector.innerHTML = '';
        config.models.forEach(model => {
          const opt = document.createElement('option');
          opt.value = model;
          opt.textContent = model;
          selector.appendChild(opt);
        });
      }
      if (config.selectedModel) {
        selector.value = config.selectedModel;
      }
    }
  } catch (err) {
    console.error('Error loading model config:', err);
  }
}
async function onModelChange(model) {
  try {
    const res = await fetch('/api/model/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model })
    });
    const result = await res.json();
    console.log('Model selection updated:', result.selectedModel);
  } catch (err) {
    console.error('Error changing model:', err);
  }
}

async function loadConversationsDropdown() {
  const selector = document.getElementById('convo-selector');
  if (!selector) return;
  
  try {
    const res = await fetch('/api/conversations');
    const conversations = await res.json();
    
    selector.innerHTML = '';
    
    // Default/fallback option if no conversations
    if (conversations.length === 0) {
      selector.innerHTML = '<option value="">No conversations found</option>';
      return;
    }
    
    conversations.forEach(convo => {
      const opt = document.createElement('option');
      opt.value = convo.id;
      opt.textContent = `${convo.project ? '[' + convo.project + '] ' : ''}${convo.title}`;
      selector.appendChild(opt);
    });
    
    if (activeConvoId) {
      selector.value = activeConvoId;
    }
  } catch (err) {
    console.error('Error loading conversations dropdown:', err);
  }
}

async function onConvoChange(convoId) {
  if (!convoId) return;
  try {
    const res = await fetch('/api/conversations/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: convoId })
    });
    
    if (res.ok) {
      activeConvoId = convoId;
      refreshActiveChat(convoId);
    }
  } catch (err) {
    console.error('Error changing conversation:', err);
  }
}

// Collapsible logs
function toggleLogs() {
  const btn = document.getElementById('btn-toggle-logs');
  const container = document.getElementById('agent-logs-container');
  btn.classList.toggle('active');
  container.classList.toggle('collapsed');
}

// Autocomplete and input handlers
function handlePromptInput(textarea) {
  // Auto-resize textarea height
  textarea.style.height = 'auto';
  textarea.style.height = (textarea.scrollHeight) + 'px';

  const val = textarea.value;
  const popup = document.getElementById('autocomplete-popup');
  
  // Show popup if textarea content ends with / or is just /
  if (val.trim() === '/' || val.endsWith(' /') || val.endsWith('\n/')) {
    popup.classList.remove('hidden');
  } else {
    popup.classList.add('hidden');
  }
}

function handlePromptKeyDown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitAgentPrompt();
  }
}

function insertWorkflow(workflow) {
  const textarea = document.getElementById('agent-prompt');
  textarea.value = workflow + ' ';
  textarea.focus();
  handlePromptInput(textarea);
  document.getElementById('autocomplete-popup').classList.add('hidden');
}

// Helper to handle option selection in clarifying questions
function selectQuestionOption(optionText) {
  const textarea = document.getElementById('agent-prompt');
  if (textarea) {
    textarea.value = optionText;
    textarea.focus();
    handlePromptInput(textarea);
    textarea.scrollIntoView({ behavior: 'smooth' });
  }
}

// Helper to create chat bubble element based on sender and content
function createChatBubbleElement(step) {
  const bubble = document.createElement('div');
  const timeStr = new Date(step.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  if (step.sender === 'agent-question') {
    bubble.className = 'chat-bubble question-card';
    
    let optionsHtml = '';
    if (step.options && Array.isArray(step.options)) {
      optionsHtml = `<div class="question-options">`;
      step.options.forEach((opt, idx) => {
        const isRec = opt.startsWith('(Recommended)');
        const cleanOpt = isRec ? opt.replace('(Recommended)', '').trim() : opt;
        optionsHtml += `
          <div class="question-option ${isRec ? 'recommended' : ''}" onclick="selectQuestionOption('${cleanOpt.replace(/'/g, "\\'")}')">
            <span class="option-idx">${idx + 1}</span>
            <span class="option-text">${cleanOpt}</span>
            ${isRec ? '<span class="rec-badge">REC</span>' : ''}
          </div>
        `;
      });
      optionsHtml += `</div>`;
    }
    
    bubble.innerHTML = `
      <div class="question-header">
        <i data-lucide="help-circle" style="width:14px;height:14px;margin-right:4px;display:inline-block;vertical-align:middle;"></i>
        CLARIFYING QUESTION
      </div>
      <div class="question-text">${step.question.replace(/\n/g, '<br>')}</div>
      ${optionsHtml}
      <span class="chat-bubble-time">${timeStr}</span>
    `;
  } else if (step.sender === 'user-answer') {
    bubble.className = 'chat-bubble answer-card';
    
    let cleanText = (step.text || '')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
      
    bubble.innerHTML = `
      <div class="answer-header">
        <i data-lucide="check-circle-2" style="width:14px;height:14px;margin-right:4px;display:inline-block;vertical-align:middle;"></i>
        ANSWER
      </div>
      <p>${cleanText}</p>
      <span class="chat-bubble-time">${timeStr}</span>
    `;
  } else {
    bubble.className = `chat-bubble ${step.sender}`;
    let cleanText = (step.text || '')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
      
    bubble.innerHTML = `
      <p>${cleanText}</p>
      <span class="chat-bubble-time">${timeStr}</span>
    `;
  }
  
  return bubble;
}

// Active conversation chat transcript rendering
let activeConvoId = null;

async function refreshActiveChat(forceConvoId = null) {
  const chatHistory = document.getElementById('agent-chat-history');
  if (!chatHistory) return;

  try {
    if (forceConvoId) {
      activeConvoId = forceConvoId;
    } else {
      const activeRes = await fetch('/api/conversations/active');
      if (!activeRes.ok) {
        renderChatPlaceholder();
        return;
      }
      const activeData = await activeRes.json();
      activeConvoId = activeData.id;
    }

    const convoRes = await fetch(`/api/conversations/${activeConvoId}`);
    if (!convoRes.ok) {
      renderChatPlaceholder();
      return;
    }
    const convoData = await convoRes.json();

    if (!convoData.steps || convoData.steps.length === 0) {
      renderChatPlaceholder();
      return;
    }

    // Check if scrolled to bottom (or close to it) before drawing
    const wasScrolledToBottom = chatHistory.scrollHeight - chatHistory.clientHeight <= chatHistory.scrollTop + 30;

    chatHistory.innerHTML = '';
    convoData.steps.forEach(step => {
      const bubble = createChatBubbleElement(step);
      chatHistory.appendChild(bubble);
    });

    // Initialize newly added icons
    if (window.lucide) {
      window.lucide.createIcons();
    }

    if (wasScrolledToBottom || forceConvoId === null) {
      chatHistory.scrollTop = chatHistory.scrollHeight;
    }
  } catch (err) {
    console.error('Error refreshing active chat:', err);
    if (chatHistory.children.length === 0) {
      renderChatPlaceholder();
    }
  }
}

function renderChatPlaceholder() {
  const chatHistory = document.getElementById('agent-chat-history');
  if (chatHistory) {
    chatHistory.innerHTML = `
      <div class="chat-placeholder">
        <i data-lucide="message-square" style="width: 48px; height: 48px; opacity: 0.3; margin-bottom: 12px;"></i>
        <p>No active chat messages. Send a prompt below to start.</p>
      </div>
    `;
    lucide.createIcons();
  }
}

function submitAgentPrompt() {
  const promptArea = document.getElementById('agent-prompt');
  const prompt = promptArea.value.trim();
  
  if (!prompt) return;
  
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'agent_submit',
      prompt
    }));
    appendAgentLog(`[Prompt] Submitted task: "${prompt}"`, 'prompt');
    promptArea.value = '';
    promptArea.style.height = 'auto';
    document.getElementById('autocomplete-popup').classList.add('hidden');
    
    // Refresh chat immediately to show user bubble (after small delay for log writing)
    setTimeout(refreshActiveChat, 200);
  } else {
    alert('Not connected to Mac server');
  }
}

function updateAgentStatusUI(data) {
  const banner = document.getElementById('agent-banner');
  const title = document.getElementById('agent-status-title');
  const subtitle = document.getElementById('agent-step-title');
  
  if (banner) banner.className = `agent-status-banner-mini ${data.status}`;
  if (title) title.textContent = `Status: ${data.status.toUpperCase()}`;
  if (subtitle) subtitle.textContent = data.current_step;

  if (data.logs && data.logs.length > 0) {
    const logsContainer = document.getElementById('agent-logs');
    logsContainer.innerHTML = '';
    data.logs.forEach(log => {
      let type = 'log';
      if (log.startsWith('[Client]') || log.startsWith('[Prompt]')) type = 'prompt';
      else if (log.includes('successfully') || log.includes('Success')) type = 'success';
      else if (log.includes('Error') || log.includes('failed')) type = 'error';
      else if (log.startsWith('[System]')) type = 'system';
      else if (log.startsWith('[Command]')) type = 'run';
      
      appendAgentLog(log, type);
    });
  }
}

function appendAgentLog(message, type = 'log') {
  const logsContainer = document.getElementById('agent-logs');
  const div = document.createElement('div');
  div.className = `log-entry ${type}`;
  
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  div.textContent = `[${timestamp}] ${message}`;
  
  logsContainer.appendChild(div);
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

function clearLocalLogs() {
  document.getElementById('agent-logs').innerHTML = '<div class="log-entry system">[System] Logs cleared on client</div>';
}

// 4. Navigation/Tab Switcher
function switchTab(tabId) {
  // Hide all panels
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  // Deactivate all nav items
  document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
  
  // Show active panel
  document.getElementById(`panel-${tabId}`).classList.add('active');
  
  // Activate selected nav button
  const navBtn = Array.from(document.querySelectorAll('.nav-item')).find(btn => btn.getAttribute('onclick').includes(tabId));
  if (navBtn) navBtn.classList.add('active');

  // Trigger tab-specific initialization
  if (tabId === 'monitor') {
    subscribeStats();
  } else if (tabId === 'terminal') {
    initTerminal();
  } else if (tabId === 'agent') {
    loadModelConfig();
    refreshActiveChat().then(() => loadConversationsDropdown());
  } else if (tabId === 'workspace') {
    const urlParams = new URLSearchParams(window.location.search);
    const seg = urlParams.get('seg') || 'projects';
    const convoId = urlParams.get('convo');
    switchWorkspaceSegment(seg);
    if (convoId) {
      setTimeout(() => {
        openConversation(convoId, 'Conversation Transcript');
      }, 500);
    }
  }
}

// 5. Workspace Tab Helpers
let currentWorkspaceSegment = 'projects';

function switchWorkspaceSegment(segment) {
  currentWorkspaceSegment = segment;
  
  // Update segment buttons
  document.querySelectorAll('.segment-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`seg-${segment}`).classList.add('active');
  
  // Update segment panels
  document.querySelectorAll('.workspace-segment-content').forEach(p => p.classList.remove('active-segment'));
  document.getElementById(`workspace-${segment}`).classList.add('active-segment');
  
  if (segment === 'projects') {
    fetchProjects();
  } else if (segment === 'conversations') {
    fetchConversations();
  }
}

async function fetchProjects() {
  const loading = document.getElementById('projects-loading');
  const list = document.getElementById('projects-list');
  
  loading.style.display = 'block';
  list.innerHTML = '';
  
  try {
    const res = await fetch('/api/projects');
    const projects = await res.json();
    loading.style.display = 'none';
    
    if (projects.length === 0) {
      list.innerHTML = '<div class="loading-spinner">No projects found.</div>';
      return;
    }
    
    projects.forEach(proj => {
      const card = document.createElement('div');
      card.className = 'project-card';
      card.onclick = () => {
        // Option to run terminal command to cd to that project
        if (socket && socket.readyState === WebSocket.OPEN) {
          switchTab('terminal');
          socket.send(JSON.stringify({
            type: 'terminal_input',
            data: `cd ${proj.path} && clear && ls -la\n`
          }));
        }
      };
      
      card.innerHTML = `
        <div class="card-main">
          <span class="card-title">${proj.name}</span>
          <div class="card-meta">
            <span class="branch-tag"><i data-lucide="git-branch" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-right:2px;"></i>${proj.branch}</span>
            <span>Modified: ${new Date(proj.mtime).toLocaleDateString()}</span>
          </div>
        </div>
        <div class="card-arrow"><i data-lucide="terminal" style="width:18px;height:18px;"></i></div>
      `;
      list.appendChild(card);
    });
    lucide.createIcons();
  } catch (e) {
    loading.style.display = 'none';
    list.innerHTML = `<div class="loading-spinner" style="color:var(--accent-red)">Error loading projects: ${e.message}</div>`;
  }
}

let currentOverlayConvoId = null;

async function fetchConversations() {
  const loading = document.getElementById('conversations-loading');
  const list = document.getElementById('conversations-list');
  
  loading.style.display = 'block';
  list.innerHTML = '';
  
  try {
    const res = await fetch('/api/conversations');
    const conversations = await res.json();
    loading.style.display = 'none';
    
    if (conversations.length === 0) {
      list.innerHTML = '<div class="loading-spinner">No conversations found.</div>';
      return;
    }
    
    conversations.forEach(convo => {
      const card = document.createElement('div');
      card.className = 'conversation-card';
      card.onclick = () => openConversation(convo.id, convo.title);
      
      const formattedDate = new Date(convo.date).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      const projectTagHtml = convo.project && convo.project !== 'Unknown Project' ? `
        <span class="project-tag">
          <i data-lucide="folder" style="width:10px;height:10px;display:inline-block;vertical-align:middle;margin-right:2px;"></i>
          ${convo.project}
        </span>
      ` : '';
      
      card.innerHTML = `
        <div class="card-main">
          <span class="card-title">${convo.title}</span>
          <div class="card-meta">
            ${projectTagHtml}
            <span>ID: ${convo.id.substring(0, 8)}</span>
            <span>•</span>
            <span>${formattedDate}</span>
          </div>
        </div>
        <div class="card-arrow"><i data-lucide="chevron-right"></i></div>
      `;
      list.appendChild(card);
    });
    lucide.createIcons();
  } catch (e) {
    loading.style.display = 'none';
    list.innerHTML = `<div class="loading-spinner" style="color:var(--accent-red)">Error loading conversations: ${e.message}</div>`;
  }
}

async function openConversation(id, title) {
  currentOverlayConvoId = id;
  const overlay = document.getElementById('conversation-overlay');
  const overlayTitle = document.getElementById('overlay-convo-title');
  const overlayBody = document.getElementById('overlay-convo-body');
  
  overlayTitle.textContent = title;
  overlayBody.innerHTML = '<div class="loading-spinner">Loading transcript...</div>';
  overlay.classList.add('active');
  
  try {
    const res = await fetch(`/api/conversations/${id}`);
    const data = await res.json();
    overlayBody.innerHTML = '';
    
    if (!data.steps || data.steps.length === 0) {
      overlayBody.innerHTML = '<div class="loading-spinner">Empty conversation transcript.</div>';
      return;
    }
    
    data.steps.forEach(step => {
      const bubble = createChatBubbleElement(step);
      overlayBody.appendChild(bubble);
    });

    if (window.lucide) {
      window.lucide.createIcons();
    }
    
    overlayBody.scrollTop = overlayBody.scrollHeight;
  } catch (e) {
    overlayBody.innerHTML = `<div class="loading-spinner" style="color:var(--accent-red)">Error loading transcript: ${e.message}</div>`;
  }
}

async function activateCurrentOverlayConvo() {
  if (!currentOverlayConvoId) return;
  
  try {
    const res = await fetch('/api/conversations/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: currentOverlayConvoId })
    });
    
    if (res.ok) {
      activeConvoId = currentOverlayConvoId;
      closeConversationOverlay();
      switchTab('agent');
      await refreshActiveChat(activeConvoId);
      loadConversationsDropdown();
    } else {
      alert('Failed to activate conversation');
    }
  } catch (err) {
    console.error('Error activating conversation:', err);
  }
}

function closeConversationOverlay() {
  document.getElementById('conversation-overlay').classList.remove('active');
}

// Check hash on load and hash change
function handleHashRoute() {
  const hash = window.location.hash.substring(1);
  const validTabs = ['controls', 'monitor', 'terminal', 'agent', 'workspace'];
  if (validTabs.includes(hash)) {
    switchTab(hash);
  }
}

window.addEventListener('hashchange', handleHashRoute);
window.addEventListener('load', handleHashRoute);

// Connect immediately on load
connect();

// Safe localStorage helper to avoid crashes in private/incognito mode
const storage = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      console.warn('localStorage.getItem failed:', e);
      return this._fallbackStorage[key] || null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (e) {
      console.warn('localStorage.setItem failed:', e);
      this._fallbackStorage[key] = value;
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch (e) {
      console.warn('localStorage.removeItem failed:', e);
      delete this._fallbackStorage[key];
    }
  },
  _fallbackStorage: {}
};

// Determine websocket address based on current page address
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProtocol}//${window.location.host}`;

let socket = null;
let reconnectInterval = 3000;
let statsSubscribed = false;

// Security helpers
let isLoginOverlayVisible = false;

function showLoginOverlay() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    isLoginOverlayVisible = true;
  }
}

function hideLoginOverlay() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) {
    overlay.classList.add('hidden');
    isLoginOverlayVisible = false;
  }
  const errorMsg = document.getElementById('login-error-msg');
  if (errorMsg) {
    errorMsg.classList.add('hidden');
  }
}

async function authFetch(url, options = {}) {
  const pin = storage.getItem('antigravity_pin') || '';
  if (!options.headers) {
    options.headers = {};
  }
  if (pin) {
    options.headers['Authorization'] = `Bearer ${pin}`;
  }
  
  try {
    const res = await fetch(url, options);
    if (res.status === 401) {
      showLoginOverlay();
      throw new Error('Unauthorized');
    }
    return res;
  } catch (err) {
    console.error('Fetch error:', err);
    throw err;
  }
}

async function attemptLogin() {
  const pinInput = document.getElementById('pin-input');
  const pin = pinInput.value.trim();
  const errorMsg = document.getElementById('login-error-msg');
  const btnLogin = document.getElementById('btn-login');
  
  if (!/^\d{6}$/.test(pin)) {
    errorMsg.textContent = 'Mã PIN phải là 6 chữ số.';
    errorMsg.classList.remove('hidden');
    return;
  }
  
  btnLogin.disabled = true;
  errorMsg.classList.add('hidden');
  
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    
    if (res.ok) {
      storage.setItem('antigravity_pin', pin);
      hideLoginOverlay();
      pinInput.value = '';
      
      // Reconnect WebSocket with new PIN token
      if (socket) {
        socket.close();
      } else {
        connect();
      }
      
      // Reload page state
      loadModelConfig();
      loadConversationsDropdown();
      loadSecuritySettingsUI();
    } else {
      const errText = await res.text();
      alert('Đăng nhập thất bại (Server trả về lỗi): ' + errText);
      errorMsg.textContent = 'Mã PIN không đúng. Vui lòng thử lại.';
      errorMsg.classList.remove('hidden');
    }
  } catch (err) {
    alert('Lỗi kết nối tới server (Fetch Error): ' + err.message + '\n' + err.stack);
    errorMsg.textContent = 'Lỗi kết nối tới server.';
    errorMsg.classList.remove('hidden');
  } finally {
    btnLogin.disabled = false;
  }
}


// Connect to websocket server
function connect() {
  updateConnectionStatus('connecting', 'Connecting...');
  
  const pin = storage.getItem('antigravity_pin') || '';
  const wsUrlWithToken = pin ? `${wsUrl}?token=${pin}` : wsUrl;
  
  try {
    socket = new WebSocket(wsUrlWithToken);
    
    socket.onopen = () => {
      console.log('Connected to server');
      updateConnectionStatus('connected', 'Connected');
      
      // Load model config and security settings initially
      loadModelConfig();
      loadSecuritySettingsUI();

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

    socket.onclose = (event) => {
      console.log('Connection closed, retrying...');
      updateConnectionStatus('disconnected', 'Offline (Retrying...)');
      statsSubscribed = false;
      
      if (event.code === 4001) {
        showLoginOverlay();
      } else {
        setTimeout(connect, reconnectInterval);
      }
    };

    socket.onerror = (err) => {
      console.error('Socket error:', err);
      try {
        socket.close();
      } catch (e) {}
    };
  } catch (err) {
    console.error('WebSocket connection initialization failed:', err);
    updateConnectionStatus('disconnected', 'Offline (Connection Error)');
    showLoginOverlay();
    // Schedule reconnect retry
    setTimeout(connect, reconnectInterval);
  }
}
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
    case 'auth_failed':
      showLoginOverlay();
      break;
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
      if (!activeConvoId || msg.activeConvoId === activeConvoId) {
        refreshActiveChat(msg.activeConvoId);
      }
      break;
    case 'control_ack':
      console.log(`Action ${msg.action} executed. Success: ${msg.success}`);
      break;
  }
}

// 1. Monitor Tab UI Updates
function updateStatsUI(data) {
  const { cpu, mem, battery } = data;
  
  // Media Info Update
  const mediaTitle = document.getElementById('media-title');
  const mediaArtist = document.getElementById('media-artist');
  if (mediaTitle && mediaArtist && data.media) {
    mediaTitle.textContent = data.media.track || 'No media playing';
    mediaArtist.textContent = data.media.artist || 'Spotify / Apple Music';
  }

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
    const res = await authFetch('/api/model/config');
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
    const res = await authFetch('/api/model/select', {
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
    const res = await authFetch('/api/conversations');
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
    const res = await authFetch('/api/conversations/active', {
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

function sanitizeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
}

// Render simple markdown tags with syntax highlights support
function renderMarkdown(text) {
  if (!text) return '';
  
  // Escape HTML to prevent XSS
  let html = sanitizeHTML(text);
  
  // Convert Code blocks first so we don't apply other markdown rules inside code
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    const placeholder = `__CODE_BLOCK_PLACEHOLDER_${codeBlocks.length}__`;
    codeBlocks.push({ lang, code });
    return placeholder;
  });
  
  // Inline code
  const inlineCodes = [];
  html = html.replace(/`([^`\n]+)`/g, (match, code) => {
    const placeholder = `__INLINE_CODE_PLACEHOLDER_${inlineCodes.length}__`;
    inlineCodes.push(code);
    return placeholder;
  });
  
  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  
  // Italic
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  
  // Convert newlines to paragraphs and breaks
  let formattedHtml = '';
  const paragraphs = html.split(/\n\n+/);
  paragraphs.forEach(para => {
    if (para.trim()) {
      // Check if paragraph is a list
      const lines = para.split('\n');
      let isList = false;
      let listHtml = '<ul>';
      lines.forEach(line => {
        const listMatch = line.match(/^(\s*)[-*]\s+(.*)/);
        if (listMatch) {
          isList = true;
          listHtml += `<li>${listMatch[2]}</li>`;
        }
      });
      listHtml += '</ul>';
      
      if (isList) {
        formattedHtml += listHtml;
      } else {
        // Replace single newline with <br>
        const paraWithBreaks = para.replace(/\n/g, '<br>');
        formattedHtml += `<p>${paraWithBreaks}</p>`;
      }
    }
  });
  
  // Restore inline codes
  inlineCodes.forEach((code, idx) => {
    formattedHtml = formattedHtml.replace(`__INLINE_CODE_PLACEHOLDER_${idx}__`, `<code>${code}</code>`);
  });
  
  // Restore code blocks with Highlight.js-ready markup
  codeBlocks.forEach((item, idx) => {
    const languageClass = item.lang ? ` class="language-${item.lang}"` : '';
    formattedHtml = formattedHtml.replace(`__CODE_BLOCK_PLACEHOLDER_${idx}__`, 
      `<pre><code${languageClass}>${item.code}</code></pre>`);
  });
  
  return formattedHtml;
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
        const rawOpt = isRec ? opt.replace('(Recommended)', '').trim() : opt;
        const cleanOpt = sanitizeHTML(rawOpt);
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
    
    const cleanQuestion = sanitizeHTML(step.question || '').replace(/\n/g, '<br>');
    bubble.innerHTML = `
      <div class="question-header">
        <i data-lucide="help-circle" style="width:14px;height:14px;margin-right:4px;display:inline-block;vertical-align:middle;"></i>
        CLARIFYING QUESTION
      </div>
      <div class="question-text">${cleanQuestion}</div>
      ${optionsHtml}
      <span class="chat-bubble-time">${timeStr}</span>
    `;
  } else if (step.sender === 'user-answer') {
    bubble.className = 'chat-bubble answer-card';
    
    let cleanText = sanitizeHTML(step.text || '')
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
  } else if (step.sender === 'agent-thinking') {
    bubble.className = 'chat-bubble agent-thinking-card expanded';
    bubble.innerHTML = `
      <div class="thinking-header" onclick="this.parentElement.classList.toggle('expanded')">
        <i data-lucide="brain-circuit" style="width:14px;height:14px;margin-right:4px;"></i>
        <span>Thinking Process</span>
        <i data-lucide="chevron-down" class="chevron-icon" style="width:14px;height:14px;margin-left:auto;"></i>
      </div>
      <div class="thinking-content">
        ${renderMarkdown(step.text)}
      </div>
      <span class="chat-bubble-time">${timeStr}</span>
    `;
  } else if (step.sender === 'tool-call') {
    bubble.className = 'chat-bubble tool-call-card expanded';
    
    let argsStr = '';
    try {
      const parsedArgs = (typeof step.args === 'string') ? JSON.parse(step.args) : step.args;
      argsStr = JSON.stringify(parsedArgs, null, 2);
    } catch (e) {
      argsStr = String(step.args);
    }
    
    bubble.innerHTML = `
      <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
        <i data-lucide="wrench" style="width:14px;height:14px;margin-right:4px;"></i>
        <span>Call: <strong>${step.toolName}</strong></span>
        <i data-lucide="chevron-down" class="chevron-icon" style="width:14px;height:14px;margin-left:auto;"></i>
      </div>
      <div class="tool-args">
        <pre><code class="language-json">${sanitizeHTML(argsStr)}</code></pre>
      </div>
      <span class="chat-bubble-time">${timeStr}</span>
    `;
  } else if (step.sender === 'tool-execution') {
    bubble.className = `chat-bubble tool-execution-card ${step.status.toLowerCase()}`;
    const icon = step.status === 'ERROR' ? 'alert-triangle' : 'terminal';
    
    bubble.innerHTML = `
      <div class="tool-header" onclick="this.parentElement.classList.toggle('expanded')">
        <i data-lucide="${icon}" style="width:14px;height:14px;margin-right:4px;"></i>
        <span>Result: <strong>${step.toolName}</strong></span>
        <span class="status-indicator ${step.status.toLowerCase()}">${step.status}</span>
        <i data-lucide="chevron-down" class="chevron-icon" style="width:14px;height:14px;margin-left:auto;"></i>
      </div>
      <div class="tool-output">
        <pre><code>${sanitizeHTML(step.text || '')}</code></pre>
      </div>
      <span class="chat-bubble-time">${timeStr}</span>
    `;
  } else {
    bubble.className = `chat-bubble ${step.sender}`;
    bubble.innerHTML = `
      ${renderMarkdown(step.text)}
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
    } else if (!activeConvoId) {
      const activeRes = await authFetch('/api/conversations/active');
      if (!activeRes.ok) {
        renderChatPlaceholder();
        return;
      }
      const activeData = await activeRes.json();
      activeConvoId = activeData.id;
    }

    const convoRes = await authFetch(`/api/conversations/${activeConvoId}`);
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

    // Highlight code blocks
    if (window.hljs) {
      chatHistory.querySelectorAll('pre code').forEach((el) => {
        window.hljs.highlightElement(el);
      });
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
      prompt,
      convoId: activeConvoId
    }));
    appendAgentLog(`[Prompt] Submitted task: "${prompt}"`, 'prompt');
    promptArea.value = '';
    promptArea.style.height = 'auto';
    document.getElementById('autocomplete-popup').classList.add('hidden');
    
    // Refresh chat immediately to show user bubble (after small delay for log writing)
    setTimeout(() => refreshActiveChat(activeConvoId), 200);
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
  const panel = document.getElementById(`panel-${tabId}`);
  if (panel) {
    panel.classList.add('active');
  }
  
  // Activate selected nav button (preferring data-tab, falling back to onclick text query)
  const navBtn = document.querySelector(`.nav-item[data-tab="${tabId}"]`) || 
                 Array.from(document.querySelectorAll('.nav-item')).find(btn => {
                   const onc = btn.getAttribute('onclick');
                   return onc && typeof onc === 'string' && onc.includes(tabId);
                 });
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
    const res = await authFetch('/api/projects');
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
    const res = await authFetch('/api/conversations');
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
    const res = await authFetch(`/api/conversations/${id}`);
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
    
    // Highlight code blocks
    if (window.hljs) {
      overlayBody.querySelectorAll('pre code').forEach((el) => {
        window.hljs.highlightElement(el);
      });
    }
    
    overlayBody.scrollTop = overlayBody.scrollHeight;
  } catch (e) {
    overlayBody.innerHTML = `<div class="loading-spinner" style="color:var(--accent-red)">Error loading transcript: ${e.message}</div>`;
  }
}

async function activateCurrentOverlayConvo() {
  if (!currentOverlayConvoId) return;
  
  try {
    const res = await authFetch('/api/conversations/active', {
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

// 6. Security & Authorization Settings
function togglePinInputDisabled() {
  const toggle = document.getElementById('pin-toggle');
  const pinField = document.getElementById('settings-pin');
  if (toggle && pinField) {
    pinField.disabled = !toggle.checked;
  }
}

async function loadSecuritySettingsUI() {
  try {
    const res = await authFetch('/api/settings');
    const settings = await res.json();
    
    const toggle = document.getElementById('pin-toggle');
    const pinField = document.getElementById('settings-pin');
    
    if (toggle) {
      toggle.checked = settings.pinSecurityEnabled;
    }
    if (pinField) {
      pinField.value = settings.pin || '';
    }
    togglePinInputDisabled();
  } catch (err) {
    console.error('Error loading security settings:', err);
  }
}

async function saveSecuritySettings() {
  const toggle = document.getElementById('pin-toggle');
  const pinField = document.getElementById('settings-pin');
  const statusMsg = document.getElementById('settings-status-msg');
  const btn = document.getElementById('btn-save-settings');
  
  if (!toggle || !pinField || !statusMsg) return;
  
  const pinSecurityEnabled = toggle.checked;
  const pin = pinField.value.trim();
  
  if (pinSecurityEnabled && !/^\d{6}$/.test(pin)) {
    statusMsg.textContent = 'PIN must be exactly 6 digits';
    statusMsg.className = 'settings-status-msg error';
    return;
  }
  
  btn.disabled = true;
  statusMsg.textContent = 'Saving...';
  statusMsg.className = 'settings-status-msg';
  
  try {
    const res = await authFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinSecurityEnabled, pin })
    });
    
    if (res.ok) {
      const data = await res.json();
      statusMsg.textContent = 'Settings saved successfully!';
      statusMsg.className = 'settings-status-msg success';
      
      // Update local storage PIN if enabled and changed
      if (pinSecurityEnabled && pin) {
        storage.setItem('antigravity_pin', pin);
      }
      
      setTimeout(() => {
        statusMsg.textContent = '';
      }, 3000);
    } else {
      const errData = await res.json();
      statusMsg.textContent = errData.error || 'Failed to save settings';
      statusMsg.className = 'settings-status-msg error';
    }
  } catch (err) {
    statusMsg.textContent = 'Error connecting to server';
    statusMsg.className = 'settings-status-msg error';
  } finally {
    btn.disabled = false;
  }
}

// 6a. Cloudflare Tunnel & QR Connect State management
async function checkTunnelStatus() {
  const tunnelStatusBadge = document.getElementById('tunnel-status');
  const tunnelUrlContainer = document.getElementById('tunnel-url-container');
  const tunnelUrlLink = document.getElementById('tunnel-url');
  const btnStart = document.getElementById('btn-start-tunnel');
  const btnStop = document.getElementById('btn-stop-tunnel');
  
  if (!tunnelStatusBadge) return;
  
  try {
    const res = await authFetch('/api/tunnel/status');
    if (res.ok) {
      const data = await res.json();
      
      // Update UI
      tunnelStatusBadge.textContent = data.status.toUpperCase();
      tunnelStatusBadge.className = `status-badge ${data.status}`;
      
      if (data.status === 'running' && data.url) {
        tunnelUrlContainer.classList.remove('hidden');
        tunnelUrlLink.href = data.url;
        tunnelUrlLink.textContent = data.url;
        if (btnStart) btnStart.disabled = true;
        if (btnStop) btnStop.disabled = false;
      } else if (data.status === 'starting') {
        tunnelStatusBadge.textContent = 'STARTING...';
        tunnelUrlContainer.classList.add('hidden');
        if (btnStart) btnStart.disabled = true;
        if (btnStop) btnStop.disabled = false;
      } else {
        tunnelUrlContainer.classList.add('hidden');
        if (btnStart) btnStart.disabled = false;
        if (btnStop) btnStop.disabled = true;
      }
    }
  } catch (e) {
    console.error('Error checking tunnel status:', e);
  }
}

// Check tunnel status every 5 seconds
setInterval(checkTunnelStatus, 5000);

// Run on page load
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(checkTunnelStatus, 1000);
  
  // Dynamically bind navigation click events for environments that block inline onclick handlers
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const tabId = item.getAttribute('data-tab');
      if (tabId) {
        switchTab(tabId);
      }
    });
  });
});

async function startRemoteTunnel() {
  const statusMsg = document.getElementById('settings-status-msg');
  const btnStart = document.getElementById('btn-start-tunnel');
  const tunnelStatusBadge = document.getElementById('tunnel-status');
  
  if (!statusMsg || !btnStart) return;
  
  btnStart.disabled = true;
  statusMsg.textContent = 'Starting tunnel daemon...';
  statusMsg.className = 'settings-status-msg';
  
  if (tunnelStatusBadge) {
    tunnelStatusBadge.textContent = 'STARTING...';
    tunnelStatusBadge.className = 'status-badge starting';
  }
  
  try {
    const res = await authFetch('/api/tunnel/start', { method: 'POST' });
    if (res.ok) {
      statusMsg.textContent = 'Tunnel started successfully!';
      statusMsg.className = 'settings-status-msg success';
      await checkTunnelStatus();
      loadQRCode(); // Auto-load QR code when tunnel starts
    } else {
      const err = await res.json();
      statusMsg.textContent = err.error || 'Failed to start tunnel';
      statusMsg.className = 'settings-status-msg error';
      await checkTunnelStatus();
    }
  } catch (err) {
    statusMsg.textContent = 'Network error starting tunnel';
    statusMsg.className = 'settings-status-msg error';
    await checkTunnelStatus();
  }
  
  setTimeout(() => {
    statusMsg.textContent = '';
  }, 4000);
}

async function stopRemoteTunnel() {
  const statusMsg = document.getElementById('settings-status-msg');
  const btnStop = document.getElementById('btn-stop-tunnel');
  
  if (!statusMsg || !btnStop) return;
  
  btnStop.disabled = true;
  statusMsg.textContent = 'Stopping tunnel...';
  statusMsg.className = 'settings-status-msg';
  
  try {
    const res = await authFetch('/api/tunnel/stop', { method: 'POST' });
    if (res.ok) {
      statusMsg.textContent = 'Tunnel stopped';
      statusMsg.className = 'settings-status-msg success';
      await checkTunnelStatus();
      
      // Hide QR code wrapper and show placeholder
      document.getElementById('qr-code-wrapper').classList.add('hidden');
      const placeholder = document.getElementById('qr-code-placeholder');
      if (placeholder) {
        placeholder.classList.remove('hidden');
        placeholder.innerHTML = `
          <p style="margin-bottom: 10px;">Click below to load connection QR code (uses Tunnel or local network)</p>
          <button class="btn-secondary" onclick="loadQRCode()" style="padding: 6px 12px; font-size: 0.85rem;">
            Generate QR Code
          </button>
        `;
      }
    } else {
      statusMsg.textContent = 'Failed to stop tunnel';
      statusMsg.className = 'settings-status-msg error';
      await checkTunnelStatus();
    }
  } catch (err) {
    statusMsg.textContent = 'Network error stopping tunnel';
    statusMsg.className = 'settings-status-msg error';
    await checkTunnelStatus();
  }
  
  setTimeout(() => {
    statusMsg.textContent = '';
  }, 4000);
}

async function loadQRCode() {
  const placeholder = document.getElementById('qr-code-placeholder');
  const wrapper = document.getElementById('qr-code-wrapper');
  
  if (!placeholder || !wrapper) return;
  
  placeholder.innerHTML = '<p>Generating QR Code...</p>';
  
  try {
    // Fetch QR SVG from endpoint
    const res = await authFetch('/api/qrcode');
    if (res.ok) {
      const svgText = await res.text();
      wrapper.innerHTML = svgText;
      placeholder.classList.add('hidden');
      wrapper.classList.remove('hidden');
    } else {
      placeholder.innerHTML = `
        <p style="color:var(--accent-red)">Failed to generate QR Code</p>
        <button class="btn-secondary" onclick="loadQRCode()" style="margin-top: 10px; padding: 6px 12px; font-size: 0.85rem;">
          Retry
        </button>
      `;
    }
  } catch (err) {
    placeholder.innerHTML = `
      <p style="color:var(--accent-red)">Network error generating QR</p>
      <button class="btn-secondary" onclick="loadQRCode()" style="margin-top: 10px; padding: 6px 12px; font-size: 0.85rem;">
        Retry
      </button>
    `;
  }
}

// Register service worker for PWA support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(reg => {
        console.log('[Service Worker] Registered successfully with scope:', reg.scope);
      })
      .catch(err => {
        console.error('[Service Worker] Registration failed:', err);
      });
  });
}


// public/client.js
// Attach event handlers, ensure fetch uses relative URL, handle errors robustly,
// and avoid interfering with design. Keep IDs matching your HTML:
// #user-input, #send-button, #model-select, #api-status, #chat-messages

(function(){
  // safe-get helper
  const $ = id => document.getElementById(id);

  // elements (should exist in your original HTML)
  const input = $('user-input');
  const sendBtn = $('send-button');
  const messagesEl = $('chat-messages');
  const apiStatus = $('api-status') || (function(){
    const s = document.createElement('div'); s.id='api-status'; s.style.display='none'; document.body.appendChild(s); return s;
  })();
  const modelSelect = $('model-select');

  // defensive: if element missing, print to console and stop
  if(!input || !sendBtn || !messagesEl) {
    console.error('client.js: required element(s) missing. Ensure #user-input, #send-button, #chat-messages exist in index.html');
    return;
  }

  // Ensure send button clickable by forcing pointer-events and z-index
  function fixButtonClickable() {
    // input & button should be above any overlay
    sendBtn.style.zIndex = 1000;
    sendBtn.style.pointerEvents = 'auto';
    input.style.zIndex = 1000;
    input.style.pointerEvents = 'auto';
    // ensure chat-messages can't cover input area
    messagesEl.style.pointerEvents = 'auto';
    messagesEl.style.zIndex = 1;
  }
  fixButtonClickable(); // run once now

  // status helper
  function setStatus(text, isError){
    apiStatus.textContent = text || '';
    apiStatus.style.color = isError ? '#ff6b6b' : '';
    apiStatus.style.display = text ? 'block' : 'none';
  }

  // append message keeping original bubble look
  function addMessage(sender, text, isUser){
    // preserve your HTML structure: create minimal wrapper that fits existing CSS
    const outer = document.createElement('div');
    outer.className = isUser ? 'message user' : 'message ai';
    const content = document.createElement('div');
    content.className = 'message-content ' + (isUser ? 'user' : 'ai');
    // keep original header if exists in your design
    let headerHTML = `<div class="message-header"><div class="username">${isUser ? 'You' : (sender || 'Indresh 2.0')}</div>
                      <div class="timestamp">${new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})}</div></div>`;
    content.innerHTML = headerHTML + `<div class="message-text">${text}</div>`;
    outer.appendChild(content);
    messagesEl.appendChild(outer);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // main send function
  let pending = false;
  async function sendMessage(text){
    if (pending) return;
    text = (text||'').trim();
    if (!text) return;
    addMessage('You', text, true);
    input.value = '';
    setStatus('Sending...');
    pending = true;
    sendBtn.disabled = true;

    const model = (modelSelect && modelSelect.value) ? modelSelect.value : 'deepseek_r1_0528';
    try {
      const resp = await fetch('/api/chat', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ message: text, conversation_id: 'diag', model })
      });
      if (!resp.ok) {
        // try to parse json error if present
        let txt = await resp.text();
        try { const j = JSON.parse(txt); txt = j.message || txt; } catch(e){}
        addMessage('Indresh 2.0', 'Server error: ' + (txt || resp.status));
        setStatus('Server error', true);
      } else {
        const data = await resp.json();
        if (data.error) {
          addMessage('Indresh 2.0', data.message || JSON.stringify(data));
          setStatus('API error', true);
        } else {
          // support both { output: { content: "..." } } and older shapes
          const reply = (data.output && data.output.content) ? data.output.content : (data.output ? JSON.stringify(data.output) : JSON.stringify(data));
          addMessage('Indresh 2.0', reply, false);
          setStatus('Connected');
        }
      }
    } catch(err) {
      console.error('Network/fetch error:', err);
      addMessage('Indresh 2.0', 'Network error: ' + (err.message || err));
      setStatus('Network error', true);
    } finally {
      pending = false;
      sendBtn.disabled = false;
    }
  }

  // attach events safely (if onclick already exists, preserve it by calling both)
  function attachSafe(el, ev, handler){
    if(!el) return;
    el.addEventListener(ev, handler);
  }

  attachSafe(sendBtn, 'click', function(e){
    e.preventDefault && e.preventDefault();
    fixButtonClickable(); // re-assert z-index/pointer-events
    sendMessage(input.value);
  });

  attachSafe(input, 'keydown', function(e){
    if(e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input.value);
    }
  });

  // copy-all (if button exists)
  const copyBtn = $('copy-all-btn');
  if(copyBtn){
    attachSafe(copyBtn, 'click', async ()=> {
      try {
        await navigator.clipboard.writeText(messagesEl.innerText || messagesEl.textContent || '');
        alert('Copied chat text to clipboard');
      } catch(e){
        alert('Copy failed: ' + (e && e.message ? e.message : e));
      }
    });
  }

  // clear (if button exists)
  const clearBtn = $('clear-btn');
  if(clearBtn) {
    attachSafe(clearBtn, 'click', async ()=>{
      messagesEl.innerHTML = '';
      try { await fetch('/api/clear/diag', { method: 'POST' }); } catch(e){}
      addMessage('Indresh 2.0', 'Chat cleared. नमस्ते — कैसे सहायता करूँ?');
    });
  }

  // history (if button exists)
  const histBtn = $('history-btn');
  if(histBtn) {
    attachSafe(histBtn, 'click', async ()=>{
      try {
        const r = await fetch('/api/history/diag');
        if(!r.ok) { setStatus('History load failed', true); return; }
        const j = await r.json();
        messagesEl.innerHTML = '';
        (j.messages || []).forEach(m => addMessage(m.role === 'user' ? 'You' : 'Indresh 2.0', m.content, m.role === 'user'));
        setStatus('History loaded');
      } catch(e) { console.error(e); setStatus('History error', true); }
    });
  }

  // theme toggle: set data-theme attribute so CSS can use [data-theme="light"]
  const themeBtn = $('theme-btn');
  function applySavedTheme(){
    const t = localStorage.getItem('theme') || '';
    if(t === 'light') document.documentElement.setAttribute('data-theme','light');
    else document.documentElement.removeAttribute('data-theme');
  }
  applySavedTheme();
  if(themeBtn){
    attachSafe(themeBtn, 'click', ()=>{
      const cur = document.documentElement.getAttribute('data-theme');
      if(cur === 'light') {
        document.documentElement.removeAttribute('data-theme');
        localStorage.removeItem('theme');
      } else {
        document.documentElement.setAttribute('data-theme','light');
        localStorage.setItem('theme','light');
      }
    });
  }

  // ensure clicks not blocked by overlays (rare)
  document.addEventListener('click', function(){ fixButtonClickable(); }, true);

  // initial status
  setStatus('Ready');
})();
// event delegation for static and future copy buttons
document.addEventListener('click', function(e){
  const btn = e.target.closest && e.target.closest('.copy-btn');
  if(!btn) return;
  const text = btn.dataset.text || '';
  if(!text) return;
  navigator.clipboard.writeText(text).then(()=> {
    const prev = btn.textContent;
    btn.textContent = '✓';
    setTimeout(()=> btn.textContent = prev, 1200);
  }).catch(()=> alert('Copy failed'));
});

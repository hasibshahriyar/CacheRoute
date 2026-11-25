(() => {
  const BASE_URL = window.location.origin;
  let currentWindow = '24h';
  let currentLogFilter = 'ALL';
  let currentSdkLang = 'ts';
  let cachedTelemetry = null;
  let lastMissMs = null;
  let activeLogRawJson = '';
  let activeModalRawJson = '';
  let rawSdkText = '';
  const sessionHistory = [];
  let adminToken = sessionStorage.getItem('cr_admin_token') || '';

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message, type = 'info') {
    const stack = $('toastStack');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(6px)';
      el.style.transition = 'opacity 160ms ease, transform 160ms ease';
      setTimeout(() => el.remove(), 180);
    }, 3400);
  }

  async function copyText(text, label = 'Copied to clipboard') {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label, 'ok');
      return true;
    } catch {
      showToast('Clipboard write blocked by browser', 'err');
      return false;
    }
  }

  function highlightJson(objOrStr) {
    const raw = typeof objOrStr === 'string' ? objOrStr : JSON.stringify(objOrStr, null, 2);
    return escapeHtml(raw).replace(
      /(&quot;(\\u[\da-fA-F]{4}|\\[^u]|[^\\&])*?&quot;(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        if (/^&quot;/.test(match)) {
          if (/:$/.test(match)) return `<span class="tok-key">${match}</span>`;
          return `<span class="tok-str">${match}</span>`;
        }
        if (/true|false|null/.test(match)) return `<span class="tok-bool">${match}</span>`;
        return `<span class="tok-num">${match}</span>`;
      },
    );
  }

  function highlightCode(code, lang) {
    let escaped = escapeHtml(code);
    if (lang === 'curl') {
      escaped = escaped
        .replace(/^curl\b/gm, '<span class="tok-kw">curl</span>')
        .replace(/(\s-[iHd]\b)/g, '<span class="tok-key">$1</span>')
        .replace(/(&quot;[^&]*?&quot;)/g, '<span class="tok-str">$1</span>');
      return escaped;
    }
    const kwPattern =
      lang === 'py'
        ? /\b(from|import|print|True|False|None)\b/g
        : /\b(import|from|const|await|new|console)\b/g;
    // Tokenize strings first so keywords inside strings stay green
    return escaped.replace(/('[^']*'|&quot;[^&]*?&quot;)/g, '\u0001$1\u0002')
      .split(/(\u0001[^\u0002]*\u0002)/g)
      .map((part) => {
        if (part.startsWith('\u0001')) {
          return `<span class="tok-str">${part.slice(1, -1)}</span>`;
        }
        return part
          .replace(kwPattern, '<span class="tok-kw">$1</span>')
          .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>');
      })
      .join('');
  }

  function formatProviderName(name) {
    const map = { groq: 'Groq', gemini: 'Gemini', openrouter: 'OpenRouter' };
    return map[String(name || '').toLowerCase()] || name;
  }

  function badgeClass(cacheStatus) {
    if (cacheStatus === 'HIT-EXACT') return 'exact';
    if (cacheStatus === 'HIT-SEMANTIC') return 'semantic';
    if (cacheStatus === 'MISS') return 'miss';
    if (cacheStatus === 'BYPASS') return 'bypass';
    return 'err';
  }

  function renderLatencyWaterfall(ms) {
    const num = Number(ms);
    if (!Number.isFinite(num)) return `<span class="mono small muted">—</span>`;
    const pct = Math.min(100, Math.max(5, Math.round((Math.log10(num + 1) / Math.log10(1500)) * 100)));
    const cls = num <= 25 ? 'lat-fast' : num <= 100 ? 'lat-med' : 'lat-slow';
    return `<div class="lat-cell">
      <div class="lat-track"><div class="lat-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="mono small tabular">${num} ms</span>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // Tab Navigation + Keyboard Shortcuts (1–4, Esc)
  // -------------------------------------------------------------------------
  function activateTab(target) {
    const btn = document.querySelector(`.nav-item[data-tab="${target}"]`);
    if (!btn) return;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${target}`).classList.add('active');
    if (target === 'analytics' || target === 'logs') loadTelemetry();
    if (target === 'sdk') renderSdkSnippet();
  }

  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.getAttribute('data-tab')));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('traceModal').classList.add('hidden');
      $('logDetailCard').classList.add('hidden');
      $('logsSplit').classList.remove('has-detail');
      document.querySelectorAll('#prodLogsBody tr.selected').forEach((r) => r.classList.remove('selected'));
      return;
    }
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.metaKey || e.ctrlKey || e.altKey) {
      return;
    }
    const map = { '1': 'playground', '2': 'analytics', '3': 'logs', '4': 'sdk' };
    if (map[e.key]) activateTab(map[e.key]);
  });

  // -------------------------------------------------------------------------
  // Live Health & Telemetry Loader
  // -------------------------------------------------------------------------
  async function loadHealth() {
    try {
      const res = await fetch('/readyz');
      const data = await res.json();
      const pgOk = Boolean(data.checks?.postgres);
      const redisOk = Boolean(data.checks?.redis);
      const p = data.providersConfigured || {};
      const provCount = [p.groq, p.gemini, p.openrouter].filter(Boolean).length;

      $('dotPg').className = 'dot pulse ' + (pgOk ? 'ok' : 'err');
      $('dotPgMobile').className = 'dot ' + (pgOk ? 'ok' : 'err');
      $('lblPg').textContent = pgOk ? 'ready' : 'down';

      $('dotRedis').className = 'dot pulse ' + (redisOk ? 'ok' : 'err');
      $('dotRedisMobile').className = 'dot ' + (redisOk ? 'ok' : 'err');
      $('lblRedis').textContent = redisOk ? 'ready' : 'down';

      $('dotProviders').className = 'dot pulse ' + (provCount > 0 ? 'ok' : 'err');
      $('dotProvMobile').className = 'dot ' + (provCount > 0 ? 'ok' : 'err');
      $('lblProviders').textContent = `${provCount}/3 active`;
    } catch {
      $('dotPg').className = 'dot err';
      $('dotRedis').className = 'dot err';
      $('dotPgMobile').className = 'dot err';
      $('dotRedisMobile').className = 'dot err';
    }
  }

  async function loadTelemetry() {
    try {
      const res = await fetch(`/v1/telemetry?window=${currentWindow}&limit=40`);
      if (!res.ok) return;
      cachedTelemetry = await res.json();
      if (cachedTelemetry.config?.region) {
        $('regionLabel').textContent = cachedTelemetry.config.region;
      }
      renderAnalytics(cachedTelemetry);
      renderProductionLogs(cachedTelemetry.recentLogs || []);
      $('navLogCount').textContent = String((cachedTelemetry.recentLogs || []).length);
    } catch {
      // ignore transient network errors
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline Animator (Tab 1)
  // -------------------------------------------------------------------------
  function updatePipeline({ cache, provider, similarity, prompt, bypass, latencyMs, ok }) {
    document.querySelectorAll('.p-node').forEach((n) => {
      n.className = 'p-node';
    });

    const entityTrap = /\d{3,}|@|https?:\/\//i.test(prompt);
    const set = (name, cls) => {
      const el = document.querySelector(`.p-node[data-node="${name}"]`);
      if (el) el.classList.add(cls);
    };

    set('client', 'passed');
    set('ratelimit', 'passed');

    if (bypass) {
      set('guard', 'warn');
      set('l1', 'skipped');
      set('l2', 'skipped');
      set('upstream', ok ? 'upstream' : 'warn');
      $('pipelineSubtitle').textContent = `Cache bypassed via header · served by ${provider} (${latencyMs} ms)`;
    } else if (cache === 'HIT-EXACT') {
      set('guard', 'passed');
      set('l1', 'hit-exact');
      set('l2', 'skipped');
      set('upstream', 'skipped');
      $('pipelineSubtitle').textContent = `Short-circuited at L1 Upstash Redis in ${latencyMs} ms · 0 upstream LLM calls`;
    } else if (cache === 'HIT-SEMANTIC') {
      set('guard', 'passed');
      set('l1', 'passed');
      set('l2', 'hit-semantic');
      set('upstream', 'skipped');
      $('pipelineSubtitle').textContent = `Matched L2 Neon pgvector (cos ${similarity}) in ${latencyMs} ms · 0 upstream LLM calls`;
    } else {
      set('guard', entityTrap ? 'warn' : 'passed');
      set('l1', 'passed');
      set('l2', entityTrap ? 'skipped' : 'passed');
      set('upstream', ok ? 'upstream' : 'warn');
      $('nodeUpstreamSub').textContent = provider || 'Groq → Gemini → OR';
      $('pipelineSubtitle').textContent = entityTrap
        ? `Entity Guard bypassed L2 semantic cache · routed to ${provider} (${latencyMs} ms)`
        : `Cache MISS · routed to ${provider} (${latencyMs} ms) & persisted asynchronously`;
    }

    const simWrap = $('simBarWrap');
    if (cache === 'HIT-SEMANTIC' && similarity) {
      const num = Number(similarity);
      simWrap.classList.remove('hidden');
      $('simBarVal').textContent = `${num.toFixed(4)} (>= 0.92)`;
      $('simBarFill').style.width = `${Math.min(100, Math.round(num * 100))}%`;
    } else {
      simWrap.classList.add('hidden');
    }

    const numericMs = Number(latencyMs);
    if (cache === 'MISS' && Number.isFinite(numericMs) && numericMs > 0) {
      lastMissMs = numericMs;
      $('speedupChip').classList.add('hidden');
    } else if (
      (cache === 'HIT-EXACT' || cache === 'HIT-SEMANTIC') &&
      Number.isFinite(numericMs) &&
      numericMs > 0
    ) {
      const baseline = lastMissMs || 991;
      const mult = Math.max(1, Math.round(baseline / Math.max(1, numericMs)));
      const saved = Math.max(0, baseline - numericMs);
      $('speedupChip').textContent = `${mult}x faster · Saved ~${saved} ms vs upstream`;
      $('speedupChip').classList.remove('hidden');
    }
  }

  // -------------------------------------------------------------------------
  // Playground Execution (Tab 1)
  // -------------------------------------------------------------------------
  function updateCharCount() {
    const len = $('prompt').value.length;
    $('promptCharCount').textContent = `${len} chars`;
  }

  $('prompt').addEventListener('input', updateCharCount);

  $('toggleKeyVis').addEventListener('click', () => {
    const input = $('apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
  });

  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      $('prompt').value = btn.getAttribute('data-prompt') || '';
      $('presetGuide').textContent = btn.getAttribute('data-guide') || '';
      updateCharCount();
      $('metaBar').innerHTML = '';
      $('output').textContent = 'Scenario loaded — press Send Request (or Ctrl+Enter) to trace.';
      $('copyOutputBtn').classList.add('hidden');
      $('statusText').textContent = '';
    });
  });

  $('prompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      executePlaygroundRequest();
    }
  });

  $('copyOutputBtn').addEventListener('click', () => {
    copyText($('output').textContent, 'Response copied');
  });

  $('clearHistoryBtn').addEventListener('click', () => {
    sessionHistory.length = 0;
    renderSessionHistory();
    showToast('Session history cleared');
  });

  async function executePlaygroundRequest(overridePrompt) {
    const btn = $('sendBtn');
    const out = $('output');
    const meta = $('metaBar');
    const statusText = $('statusText');

    const apiKey = $('apiKey').value.trim();
    const model = $('model').value;
    const prompt = (overridePrompt !== undefined ? overridePrompt : $('prompt').value).trim();
    const bypass = $('bypass').checked;
    const stream = $('stream').checked;

    if (!prompt) {
      showToast('Enter a prompt before sending', 'err');
      return;
    }
    $('prompt').value = prompt;
    updateCharCount();

    btn.disabled = true;
    out.textContent = '';
    meta.innerHTML = '';
    $('copyOutputBtn').classList.add('hidden');
    statusText.textContent = 'Running gateway pipeline...';

    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    };
    if (bypass) headers['x-cacheroute-cache'] = 'bypass';

    const t0 = performance.now();
    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          stream,
        }),
      });

      const cache = res.headers.get('x-cacheroute-cache') || (res.ok ? 'NONE' : 'ERROR');
      const provider = res.headers.get('x-cacheroute-provider') || 'unknown';
      const gwMs = res.headers.get('x-cacheroute-latency-ms') || '-';
      const attempts = res.headers.get('x-cacheroute-attempts') || '-';
      const sim = res.headers.get('x-cacheroute-similarity');
      const remaining = res.headers.get('x-ratelimit-remaining-requests');
      const requestId = res.headers.get('x-request-id') || '';

      const badges = [
        `<span class="badge ${badgeClass(cache)}">${escapeHtml(cache)}</span>`,
        `<span class="badge">provider: ${escapeHtml(provider)}</span>`,
        `<span class="badge tabular">gateway: ${escapeHtml(gwMs)} ms</span>`,
        `<span class="badge tabular">attempts: ${escapeHtml(attempts)}</span>`,
      ];
      if (sim) badges.push(`<span class="badge semantic tabular">sim: ${escapeHtml(sim)}</span>`);
      if (remaining !== null) {
        badges.push(`<span class="badge tabular">quota: ${escapeHtml(remaining)}</span>`);
      }
      meta.innerHTML = badges.join('');

      updatePipeline({
        cache,
        provider,
        similarity: sim,
        prompt,
        bypass,
        latencyMs: gwMs,
        ok: res.ok,
      });

      let responseContent = '';
      let rawResponse = null;

      if (!res.ok) {
        responseContent = await res.text();
        out.textContent = responseContent;
        statusText.textContent = `HTTP ${res.status} · ${Math.round(performance.now() - t0)} ms RTT`;
      } else if (!stream) {
        const json = await res.json();
        rawResponse = json;
        responseContent = json.choices?.[0]?.message?.content || JSON.stringify(json, null, 2);
        out.textContent = responseContent;
        statusText.textContent = `200 OK · ${Math.round(performance.now() - t0)} ms RTT`;
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') continue;
            try {
              const chunk = JSON.parse(payload);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) {
                responseContent += delta;
                out.textContent = responseContent;
              }
            } catch {
              // ignore fragment
            }
          }
        }
        statusText.textContent = `SSE complete · ${Math.round(performance.now() - t0)} ms`;
      }

      if (responseContent) $('copyOutputBtn').classList.remove('hidden');

      sessionHistory.unshift({
        time: new Date().toLocaleTimeString(),
        requestId,
        prompt,
        model,
        cache,
        provider,
        gwMs,
        attempts,
        similarity: sim,
        status: res.status,
        stream,
        headers: {
          'x-request-id': requestId,
          'x-cacheroute-cache': cache,
          'x-cacheroute-provider': provider,
          'x-cacheroute-attempts': attempts,
          'x-cacheroute-latency-ms': gwMs,
          ...(sim ? { 'x-cacheroute-similarity': sim } : {}),
          'x-ratelimit-remaining-requests': remaining,
        },
        responsePreview: responseContent.slice(0, 400),
        rawResponse,
      });
      renderSessionHistory();
      setTimeout(loadTelemetry, 1200);
    } catch (err) {
      out.textContent = String(err);
      statusText.textContent = 'Request failed';
      showToast('Network error calling gateway', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  $('sendBtn').addEventListener('click', () => executePlaygroundRequest());

  function renderSessionHistory() {
    const tbody = $('sessionHistoryBody');
    $('clearHistoryBtn').classList.toggle('hidden', sessionHistory.length === 0);
    if (sessionHistory.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-cell">
        <div class="empty-title">No session traces yet</div>
        <div class="empty-sub">Requests sent from the workbench appear here with latency bars and replay controls.</div>
      </td></tr>`;
      return;
    }
    tbody.innerHTML = sessionHistory
      .map(
        (item, idx) => `
      <tr>
        <td class="prompt-cell" title="${escapeHtml(item.prompt)}">
          <div class="prompt-line">${escapeHtml(item.prompt)}</div>
          <div class="mono muted" style="font-size:0.68rem">${escapeHtml(item.time)}<span class="compact-prov"> · ${escapeHtml(item.provider)}</span>${item.similarity ? ` · sim ${escapeHtml(item.similarity)}` : ''}</div>
        </td>
        <td><span class="badge ${badgeClass(item.cache)}">${escapeHtml(item.cache)}</span></td>
        <td class="mono small col-provider">${escapeHtml(item.provider)}</td>
        <td>${renderLatencyWaterfall(item.gwMs)}</td>
        <td>
          <div class="row-actions">
            <button class="btn-secondary small" data-inspect="${idx}" type="button">Inspect</button>
            <button class="btn-secondary small" data-replay="${idx}" type="button">Replay</button>
          </div>
        </td>
      </tr>
    `,
      )
      .join('');

    tbody.querySelectorAll('[data-inspect]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = sessionHistory[Number(b.getAttribute('data-inspect'))];
        activeModalRawJson = JSON.stringify(item, null, 2);
        $('traceModalBody').innerHTML = highlightJson(activeModalRawJson);
        $('traceModal').classList.remove('hidden');
      });
    });

    tbody.querySelectorAll('[data-replay]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const item = sessionHistory[Number(b.getAttribute('data-replay'))];
        executePlaygroundRequest(item.prompt);
      });
    });
  }

  $('closeTraceModal').addEventListener('click', () => $('traceModal').classList.add('hidden'));
  $('copyModalJsonBtn').addEventListener('click', () => copyText(activeModalRawJson, 'Trace JSON copied'));
  $('traceModal').addEventListener('click', (e) => {
    if (e.target === $('traceModal')) $('traceModal').classList.add('hidden');
  });

  // -------------------------------------------------------------------------
  // Analytics & Circuit Breakers (Tab 2)
  // -------------------------------------------------------------------------
  document.querySelectorAll('.win-btn[data-win]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentWindow = btn.getAttribute('data-win') || '24h';
      document.querySelectorAll('.win-btn[data-win]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      loadTelemetry();
    });
  });

  $('refreshAnalyticsBtn').addEventListener('click', async () => {
    await loadTelemetry();
    showToast('Telemetry refreshed', 'ok');
  });
  $('refreshLogsBtn').addEventListener('click', async () => {
    await loadTelemetry();
    showToast('Production logs refreshed', 'ok');
  });

  function renderAnalytics(data) {
    const s = data.stats;
    $('kpiTotal').textContent = String(s.totalRequests);
    $('kpiWindowLabel').textContent = `Window: last ${s.window}`;
    $('kpiHitRate').textContent = `${(s.cache.hitRate * 100).toFixed(1)}%`;
    $('kpiHitBreakdown').textContent = `${s.cache.exactHits} exact · ${s.cache.semanticHits} semantic`;
    $('kpiTokensSaved').textContent = s.tokensSavedEstimate.toLocaleString();
    $('kpiLatency').textContent = `${s.latencyMs.p50} / ${s.latencyMs.p95} ms`;

    const segments = [
      { label: 'HIT-EXACT · L1 Redis', value: s.cache.exactHits, color: '#22c55e' },
      { label: 'HIT-SEMANTIC · L2 pgvector', value: s.cache.semanticHits, color: '#a78bfa' },
      { label: 'MISS · Upstream LLM', value: s.cache.misses, color: '#f59e0b' },
      { label: 'BYPASS · Forced fresh', value: s.cache.bypass, color: '#52525b' },
    ];
    const total = Math.max(1, segments.reduce((acc, x) => acc + x.value, 0));
    const r = 46;
    const C = 2 * Math.PI * r;
    let offset = 0;

    const svgParts = [
      `<circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="11" />`,
    ];
    for (const seg of segments) {
      if (seg.value <= 0) continue;
      const len = (seg.value / total) * C;
      svgParts.push(
        `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${seg.color}" stroke-width="11" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)" />`,
      );
      offset += len;
    }
    svgParts.push(
      `<text x="60" y="57" text-anchor="middle" fill="#f4f4f5" font-size="16" font-weight="600">${(s.cache.hitRate * 100).toFixed(0)}%</text>`,
      `<text x="60" y="71" text-anchor="middle" fill="#8b8b99" font-size="8.5" letter-spacing="0.06em">HIT RATE</text>`,
    );
    $('cacheDonut').innerHTML = svgParts.join('');

    $('cacheLegend').innerHTML = segments
      .map(
        (seg) => `
      <div class="legend-row">
        <span><span class="legend-dot" style="background:${seg.color}"></span>${seg.label}</span>
        <span class="mono tabular">${seg.value}</span>
      </div>
    `,
      )
      .join('');

    const breakers = data.circuitBreakers || {};
    const routes = data.routes || {};
    const providersStats = s.providers || {};

    $('breakerMatrix').innerHTML = Object.entries(routes)
      .map(([alias, chain]) => {
        const steps = chain
          .map((ep, idx) => {
            const state = breakers[ep.provider] || 'CLOSED';
            const pStat = providersStats[ep.provider];
            const statTag = pStat ? `${pStat.requests} req · ${pStat.errors} err` : 'standby';
            return `<div class="breaker-step-row">
              <div class="breaker-step-left">
                <span class="prio-tag">P${idx + 1}</span>
                <span class="breaker-prov-name">${escapeHtml(formatProviderName(ep.provider))}</span>
                <span class="breaker-model mono">${escapeHtml(ep.upstreamModel)}</span>
              </div>
              <div class="breaker-step-right">
                <span class="mono muted small tabular">${escapeHtml(statTag)}</span>
                <span class="b-pill b-${escapeHtml(state)}">${escapeHtml(state)}</span>
              </div>
            </div>`;
          })
          .join('');

        return `<div class="breaker-route">
          <div class="breaker-route-head">
            <span class="breaker-alias">${escapeHtml(alias)}</span>
            <span class="mono muted small">${chain.length}-tier failover</span>
          </div>
          <div class="breaker-steps">${steps}</div>
        </div>`;
      })
      .join('');
  }

  // -------------------------------------------------------------------------
  // Production Request Logs Explorer (Tab 3)
  // -------------------------------------------------------------------------
  document.querySelectorAll('#logFilters .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      currentLogFilter = chip.getAttribute('data-filter') || 'ALL';
      document.querySelectorAll('#logFilters .chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      renderProductionLogs(cachedTelemetry?.recentLogs || []);
    });
  });

  $('closeLogDetail').addEventListener('click', () => {
    $('logDetailCard').classList.add('hidden');
    $('logsSplit').classList.remove('has-detail');
    document.querySelectorAll('#prodLogsBody tr.selected').forEach((r) => r.classList.remove('selected'));
  });

  $('copyLogJsonBtn').addEventListener('click', () => copyText(activeLogRawJson, 'Log JSON copied'));

  function renderProductionLogs(logs) {
    const filtered = logs.filter((row) => {
      if (currentLogFilter === 'ALL') return true;
      if (currentLogFilter === 'ERROR') return row.statusCode >= 400;
      return row.cacheStatus === currentLogFilter;
    });

    const tbody = $('prodLogsBody');
    if (filtered.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="empty-cell">No matching logs found for this filter.</td></tr>';
      return;
    }

    tbody.innerHTML = filtered
      .map((row, idx) => {
        const ts = new Date(row.createdAt).toLocaleString();
        const statusCls = row.statusCode >= 400 ? 'err' : 'exact';
        return `<tr data-log-idx="${idx}">
          <td class="mono small muted tabular">${escapeHtml(ts)}</td>
          <td><span class="badge ${statusCls} tabular">${row.statusCode}</span></td>
          <td><span class="badge ${badgeClass(row.cacheStatus)}">${escapeHtml(row.cacheStatus)}</span></td>
          <td class="mono small">${escapeHtml(row.modelAlias)}</td>
          <td class="mono small">${escapeHtml(row.provider)}</td>
          <td>${renderLatencyWaterfall(row.latencyMs)}</td>
          <td class="mono small tabular">${row.promptTokens + row.completionTokens}</td>
          <td class="mono small purple tabular">${row.similarity ? row.similarity.toFixed(4) : '—'}</td>
        </tr>`;
      })
      .join('');

    tbody.querySelectorAll('tr[data-log-idx]').forEach((tr) => {
      tr.addEventListener('click', () => {
        tbody.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
        tr.classList.add('selected');
        const row = filtered[Number(tr.getAttribute('data-log-idx'))];
        activeLogRawJson = JSON.stringify(row, null, 2);
        $('logDetailSummary').innerHTML = `
          <div class="trace-kv"><div class="trace-k">Cache Tier</div><div class="trace-v mono">${escapeHtml(row.cacheStatus)}</div></div>
          <div class="trace-kv"><div class="trace-k">Latency</div><div class="trace-v mono tabular">${row.latencyMs} ms</div></div>
          <div class="trace-kv"><div class="trace-k">Provider / Model</div><div class="trace-v mono">${escapeHtml(row.provider)} · ${escapeHtml(row.modelAlias)}</div></div>
          <div class="trace-kv"><div class="trace-k">Tokens</div><div class="trace-v mono tabular">${row.promptTokens} in / ${row.completionTokens} out</div></div>
        `;
        $('logDetailJson').innerHTML = highlightJson(activeLogRawJson);
        $('logDetailCard').classList.remove('hidden');
        $('logsSplit').classList.add('has-detail');
      });
    });
  }

  // -------------------------------------------------------------------------
  // Drop-In SDK Code Snippets & Admin Panel (Tab 4)
  // -------------------------------------------------------------------------
  function renderSdkSnippet() {
    const keyVal = $('apiKey').value.trim() || 'cr_live_your_virtual_key';
    const modelVal = $('model').value || 'cr-fast';
    const snippets = {
      ts: `import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: '${keyVal}',
  baseURL: '${BASE_URL}/v1',
});

const completion = await client.chat.completions.create({
  model: '${modelVal}',
  messages: [
    { role: 'user', content: 'Explain what a Redis Lua script is in one short sentence.' }
  ],
  temperature: 0.2,
});

console.log(completion.choices[0]?.message.content);`,
      py: `from openai import OpenAI

client = OpenAI(
    api_key="${keyVal}",
    base_url="${BASE_URL}/v1",
)

response = client.chat.completions.create(
    model="${modelVal}",
    messages=[
        {"role": "user", "content": "Explain what a Redis Lua script is in one short sentence."}
    ],
    temperature=0.2,
)

print(response.choices[0].message.content)`,
      curl: `curl -i ${BASE_URL}/v1/chat/completions \\
  -H "Authorization: Bearer ${keyVal}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelVal}",
    "messages": [{"role": "user", "content": "Explain what a Redis Lua script is in one short sentence."}],
    "temperature": 0.2
  }'`,
    };
    rawSdkText = snippets[currentSdkLang];
    $('sdkCodeBox').innerHTML = highlightCode(rawSdkText, currentSdkLang);
  }

  document.querySelectorAll('#sdkTabs .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentSdkLang = btn.getAttribute('data-lang') || 'ts';
      document.querySelectorAll('#sdkTabs .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderSdkSnippet();
    });
  });

  $('copySdkBtn').addEventListener('click', async () => {
    const ok = await copyText(rawSdkText, `${currentSdkLang.toUpperCase()} snippet copied`);
    if (ok) {
      $('copySdkStatus').textContent = 'Copied';
      setTimeout(() => ($('copySdkStatus').textContent = ''), 1800);
    }
  });

  function setAdminLockedUI(unlocked) {
    $('adminUnlockForm').classList.toggle('hidden', unlocked);
    $('adminUnlockedArea').classList.toggle('hidden', !unlocked);
    $('adminStatusPill').classList.toggle('hidden', !unlocked);
    $('lockAdminBtn').classList.toggle('hidden', !unlocked);
    $('adminHintLabel').classList.toggle('hidden', unlocked);
  }

  async function loadAdminKeys(silent = false) {
    if (!adminToken) return;
    const res = await fetch('/admin/keys', {
      headers: { Authorization: 'Bearer ' + adminToken },
    });
    if (!res.ok) {
      showToast('Invalid ADMIN_TOKEN', 'err');
      adminToken = '';
      sessionStorage.removeItem('cr_admin_token');
      setAdminLockedUI(false);
      return;
    }
    const { keys } = await res.json();
    setAdminLockedUI(true);
    if (!silent) showToast('Admin session unlocked', 'ok');

    const tbody = $('adminKeysBody');
    tbody.innerHTML = keys
      .map(
        (k) => `
      <tr>
        <td class="key-name-cell">${escapeHtml(k.name)}</td>
        <td class="mono small muted">${escapeHtml(k.keyPrefix)}...</td>
        <td class="mono small tabular">${k.rpmLimit} / ${k.burst}</td>
        <td class="mono small tabular">${k.dailyTokenBudget.toLocaleString()}</td>
        <td class="mono small tabular">v${k.cacheNamespace}</td>
        <td><span class="badge ${k.revokedAt ? 'err' : 'exact'}">${k.revokedAt ? 'Revoked' : 'Active'}</span></td>
        <td>
          <div class="row-actions">
          ${
            !k.revokedAt
              ? `<button class="btn-secondary small" data-inv="${escapeHtml(k.id)}" type="button">Flush Cache</button>
                 <button class="btn-danger" data-rev="${escapeHtml(k.id)}" type="button">Revoke</button>`
              : '<span class="muted small">—</span>'
          }
          </div>
        </td>
      </tr>
    `,
      )
      .join('');

    tbody.querySelectorAll('[data-inv]').forEach((b) => {
      b.addEventListener('click', async () => {
        const keyId = b.getAttribute('data-inv');
        const r = await fetch(`/admin/cache?keyId=${encodeURIComponent(keyId)}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + adminToken },
        });
        if (r.ok) {
          const d = await r.json();
          showToast(`Cache invalidated · active namespace bumped to v${d.newNamespace}`, 'ok');
          loadAdminKeys(true);
        } else {
          showToast('Cache invalidation failed', 'err');
        }
      });
    });

    tbody.querySelectorAll('[data-rev]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!b.classList.contains('confirming')) {
          b.classList.add('confirming');
          b.textContent = 'Confirm?';
          setTimeout(() => {
            b.classList.remove('confirming');
            b.textContent = 'Revoke';
          }, 4000);
          return;
        }
        const keyId = b.getAttribute('data-rev');
        const r = await fetch(`/admin/keys/${encodeURIComponent(keyId)}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + adminToken },
        });
        if (r.ok) {
          showToast('Virtual API key revoked', 'ok');
          loadAdminKeys(true);
        }
      });
    });
  }

  $('unlockAdminBtn').addEventListener('click', () => {
    adminToken = $('adminTokenInput').value.trim();
    if (!adminToken) {
      showToast('Enter your ADMIN_TOKEN first', 'err');
      return;
    }
    sessionStorage.setItem('cr_admin_token', adminToken);
    loadAdminKeys(false);
  });

  $('adminTokenInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('unlockAdminBtn').click();
  });

  $('lockAdminBtn').addEventListener('click', () => {
    adminToken = '';
    sessionStorage.removeItem('cr_admin_token');
    $('adminTokenInput').value = '';
    $('createdKeyBanner').classList.add('hidden');
    setAdminLockedUI(false);
    showToast('Admin session locked');
  });

  $('createKeyBtn').addEventListener('click', async () => {
    const name = $('newKeyName').value.trim();
    if (!name) {
      showToast('Enter a key name first', 'err');
      $('newKeyName').focus();
      return;
    }
    const res = await fetch('/admin/keys', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + adminToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        rpmLimit: Number($('newKeyRpm').value) || 60,
        burst: Number($('newKeyBurst').value) || 20,
        dailyTokenBudget: Number($('newKeyBudget').value) || 200000,
      }),
    });
    if (res.ok) {
      const created = await res.json();
      const banner = $('createdKeyBanner');
      banner.innerHTML = `
        <div>
          <strong>Virtual Key Provisioned (shown once):</strong><br/>
          <code class="mono created-key-code">${escapeHtml(created.key)}</code>
        </div>
        <button class="btn-secondary small" id="copyNewKeyBtn" type="button">Copy Key</button>
      `;
      banner.classList.remove('hidden');
      $('copyNewKeyBtn').addEventListener('click', () => copyText(created.key, 'New API key copied'));
      $('newKeyName').value = '';
      showToast(`Created virtual key "${name}"`, 'ok');
      loadAdminKeys(true);
    } else {
      showToast('Failed to provision key', 'err');
    }
  });

  loadHealth();
  loadTelemetry();
  renderSdkSnippet();
  updateCharCount();
  if (adminToken) {
    $('adminTokenInput').value = adminToken;
    loadAdminKeys(true);
  }
})();

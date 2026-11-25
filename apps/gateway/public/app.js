(() => {
  const BASE_URL = window.location.origin;
  let currentWindow = '24h';
  let currentLogFilter = 'ALL';
  let currentSdkLang = 'ts';
  let cachedTelemetry = null;
  let lastMissMs = null;
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
    const pct = Math.min(100, Math.max(4, Math.round((Math.log10(num + 1) / Math.log10(1500)) * 100)));
    const cls = num <= 25 ? 'lat-fast' : num <= 100 ? 'lat-med' : 'lat-slow';
    return `<div class="lat-cell">
      <div class="lat-track"><div class="lat-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="mono small tabular">${num} ms</span>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // Tab Navigation
  // -------------------------------------------------------------------------
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tab');
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${target}`).classList.add('active');
      if (target === 'analytics' || target === 'logs') {
        loadTelemetry();
      }
      if (target === 'sdk') {
        renderSdkSnippet();
      }
    });
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
    const nodes = document.querySelectorAll('.p-node');
    nodes.forEach((n) => {
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
      $('pipelineSubtitle').textContent = `Cache bypassed via header -> served by ${provider} (${latencyMs} ms)`;
    } else if (cache === 'HIT-EXACT') {
      set('guard', 'passed');
      set('l1', 'hit-exact');
      set('l2', 'skipped');
      set('upstream', 'skipped');
      $('pipelineSubtitle').textContent = `Short-circuited at L1 Upstash Redis in ${latencyMs} ms (0 LLM calls)`;
    } else if (cache === 'HIT-SEMANTIC') {
      set('guard', 'passed');
      set('l1', 'passed');
      set('l2', 'hit-semantic');
      set('upstream', 'skipped');
      $('pipelineSubtitle').textContent = `Short-circuited at L2 Neon pgvector (similarity ${similarity}) in ${latencyMs} ms`;
    } else {
      set('guard', entityTrap ? 'warn' : 'passed');
      set('l1', 'passed');
      set('l2', entityTrap ? 'skipped' : 'passed');
      set('upstream', ok ? 'upstream' : 'warn');
      $('nodeUpstreamSub').textContent = provider || 'Groq -> Gemini -> OR';
      $('pipelineSubtitle').textContent = entityTrap
        ? `Entity Guard skipped L2 semantic cache -> called ${provider} (${latencyMs} ms)`
        : `Cache MISS -> routed to ${provider} (${latencyMs} ms) & persisted via waitUntil`;
    }

    const simWrap = $('simBarWrap');
    if (cache === 'HIT-SEMANTIC' && similarity) {
      const num = Number(similarity);
      simWrap.classList.remove('hidden');
      $('simBarVal').textContent = `${num.toFixed(4)} (>= 0.92 threshold)`;
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
      $('speedupChip').textContent = `${mult}x faster · Saved ~${saved} ms vs upstream LLM`;
      $('speedupChip').classList.remove('hidden');
    }
  }

  // -------------------------------------------------------------------------
  // Playground Execution (Tab 1)
  // -------------------------------------------------------------------------
  document.querySelectorAll('.preset-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $('prompt').value = btn.getAttribute('data-prompt') || '';
      $('metaBar').innerHTML = '';
      $('output').textContent = 'Preset loaded — click "Send Request" (or Ctrl+Enter) to trace.';
      $('statusText').textContent = '';
    });
  });

  $('prompt').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      executePlaygroundRequest();
    }
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

    if (!prompt) return;
    $('prompt').value = prompt;

    btn.disabled = true;
    out.textContent = '';
    meta.innerHTML = '';
    statusText.textContent = 'Executing 11-stage gateway pipeline...';

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
        `<span class="badge ${badgeClass(cache)}">Cache: ${escapeHtml(cache)}</span>`,
        `<span class="badge">Provider: ${escapeHtml(provider)}</span>`,
        `<span class="badge tabular">Gateway: ${escapeHtml(gwMs)} ms</span>`,
        `<span class="badge tabular">Attempts: ${escapeHtml(attempts)}</span>`,
      ];
      if (sim) badges.push(`<span class="badge semantic tabular">Similarity: ${escapeHtml(sim)}</span>`);
      if (remaining !== null) {
        badges.push(`<span class="badge tabular">Quota left: ${escapeHtml(remaining)}</span>`);
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
        statusText.textContent = `HTTP ${res.status} (${Math.round(performance.now() - t0)} ms round-trip)`;
      } else if (!stream) {
        const json = await res.json();
        rawResponse = json;
        responseContent = json.choices?.[0]?.message?.content || JSON.stringify(json, null, 2);
        out.textContent = responseContent;
        statusText.textContent = `HTTP 200 (${Math.round(performance.now() - t0)} ms round-trip)`;
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
        statusText.textContent = `SSE complete (${Math.round(performance.now() - t0)} ms total)`;
      }

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
    } finally {
      btn.disabled = false;
    }
  }

  $('sendBtn').addEventListener('click', () => executePlaygroundRequest());

  function renderSessionHistory() {
    const tbody = $('sessionHistoryBody');
    if (sessionHistory.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="5" class="empty-cell">No requests sent in this browser session yet.</td></tr>';
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
        $('traceModalBody').textContent = JSON.stringify(item, null, 2);
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

  $('refreshAnalyticsBtn').addEventListener('click', loadTelemetry);
  $('refreshLogsBtn').addEventListener('click', loadTelemetry);

  function renderAnalytics(data) {
    const s = data.stats;
    $('kpiTotal').textContent = String(s.totalRequests);
    $('kpiWindowLabel').textContent = `Window: last ${s.window}`;
    $('kpiHitRate').textContent = `${(s.cache.hitRate * 100).toFixed(1)}%`;
    $('kpiHitBreakdown').textContent = `${s.cache.exactHits} exact · ${s.cache.semanticHits} semantic`;
    $('kpiTokensSaved').textContent = s.tokensSavedEstimate.toLocaleString();
    $('kpiLatency').textContent = `${s.latencyMs.p50} / ${s.latencyMs.p95} ms`;

    const segments = [
      { label: 'HIT-EXACT (L1 Redis)', value: s.cache.exactHits, color: '#22c55e' },
      { label: 'HIT-SEMANTIC (L2 pgvector)', value: s.cache.semanticHits, color: '#a855f7' },
      { label: 'MISS (Upstream LLM)', value: s.cache.misses, color: '#f59e0b' },
      { label: 'BYPASS', value: s.cache.bypass, color: '#71717a' },
    ];
    const total = Math.max(1, segments.reduce((acc, x) => acc + x.value, 0));
    const r = 46;
    const C = 2 * Math.PI * r;
    let offset = 0;

    const svgParts = [
      `<circle cx="60" cy="60" r="${r}" fill="none" stroke="#1d1d26" stroke-width="14" />`,
    ];
    for (const seg of segments) {
      if (seg.value <= 0) continue;
      const len = (seg.value / total) * C;
      svgParts.push(
        `<circle cx="60" cy="60" r="${r}" fill="none" stroke="${seg.color}" stroke-width="14" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 60 60)" />`,
      );
      offset += len;
    }
    svgParts.push(
      `<text x="60" y="57" text-anchor="middle" fill="#f4f4f6" font-size="16" font-weight="700">${(s.cache.hitRate * 100).toFixed(0)}%</text>`,
      `<text x="60" y="72" text-anchor="middle" fill="#9898a6" font-size="9.5">HIT RATE</text>`,
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
        const pills = chain
          .map((ep) => {
            const state = breakers[ep.provider] || 'CLOSED';
            const pStat = providersStats[ep.provider];
            const statTag = pStat ? ` · ${pStat.requests} req / ${pStat.errors} err` : '';
            return `<div class="breaker-pill">
              <strong>${escapeHtml(ep.provider)}</strong>
              <span class="b-state b-${escapeHtml(state)}">${escapeHtml(state)}</span>
              <div class="mono muted" style="font-size:0.68rem">${escapeHtml(ep.upstreamModel)}${escapeHtml(statTag)}</div>
            </div>`;
          })
          .join('<span class="p-arrow">&rarr;</span>');

        return `<div class="breaker-route">
          <div class="breaker-alias">${escapeHtml(alias)}</div>
          <div class="breaker-chain">${pills}</div>
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
  });

  function renderProductionLogs(logs) {
    const filtered = logs.filter((row) => {
      if (currentLogFilter === 'ALL') return true;
      if (currentLogFilter === 'ERROR') return row.statusCode >= 400;
      return row.cacheStatus === currentLogFilter;
    });

    const tbody = $('prodLogsBody');
    if (filtered.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="empty-cell">No matching logs found in Neon request_logs.</td></tr>';
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
        const row = filtered[Number(tr.getAttribute('data-log-idx'))];
        $('logDetailJson').textContent = JSON.stringify(row, null, 2);
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
    $('sdkCodeBox').textContent = snippets[currentSdkLang];
  }

  document.querySelectorAll('#sdkTabs .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentSdkLang = btn.getAttribute('data-lang') || 'ts';
      document.querySelectorAll('#sdkTabs .chip').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      renderSdkSnippet();
    });
  });

  $('copySdkBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('sdkCodeBox').textContent);
      $('copySdkStatus').textContent = 'Copied to clipboard!';
      setTimeout(() => ($('copySdkStatus').textContent = ''), 2000);
    } catch {
      $('copySdkStatus').textContent = 'Copy failed';
    }
  });

  async function loadAdminKeys() {
    if (!adminToken) return;
    const res = await fetch('/admin/keys', {
      headers: { Authorization: 'Bearer ' + adminToken },
    });
    if (!res.ok) {
      alert('Invalid ADMIN_TOKEN');
      adminToken = '';
      sessionStorage.removeItem('cr_admin_token');
      $('adminUnlockedArea').classList.add('hidden');
      return;
    }
    const { keys } = await res.json();
    $('adminUnlockedArea').classList.remove('hidden');

    const tbody = $('adminKeysBody');
    tbody.innerHTML = keys
      .map(
        (k) => `
      <tr>
        <td><strong>${escapeHtml(k.name)}</strong></td>
        <td class="mono small">${escapeHtml(k.keyPrefix)}...</td>
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
          alert(`Zero-downtime cache invalidation complete! New namespace: v${d.newNamespace}`);
          loadAdminKeys();
        }
      });
    });

    tbody.querySelectorAll('[data-rev]').forEach((b) => {
      b.addEventListener('click', async () => {
        const keyId = b.getAttribute('data-rev');
        if (!confirm('Revoke this virtual API key?')) return;
        await fetch(`/admin/keys/${encodeURIComponent(keyId)}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + adminToken },
        });
        loadAdminKeys();
      });
    });
  }

  $('unlockAdminBtn').addEventListener('click', () => {
    adminToken = $('adminTokenInput').value.trim();
    if (!adminToken) return;
    sessionStorage.setItem('cr_admin_token', adminToken);
    loadAdminKeys();
  });

  $('createKeyBtn').addEventListener('click', async () => {
    const name = $('newKeyName').value.trim();
    if (!name) return alert('Enter a key name.');
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
      banner.innerHTML = `<strong>New Virtual Key Created (copy now — shown once):</strong><br/><code class="mono">${escapeHtml(created.key)}</code>`;
      banner.classList.remove('hidden');
      $('newKeyName').value = '';
      loadAdminKeys();
    }
  });

  loadHealth();
  loadTelemetry();
  renderSdkSnippet();
  if (adminToken) {
    $('adminTokenInput').value = adminToken;
    loadAdminKeys();
  }
})();

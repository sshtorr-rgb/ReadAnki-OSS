// テスト画面の演出（単語テスト・作文テスト）。外部ライブラリは使わず、動きはすべて物理モデルで計算する。
//   ・ばね（減衰振動）: x'' = -k(x - 目標) - c·x'  … ポップ・ハンコ・数字のカウントアップ・バーの伸び
//   ・紙片: 重力 + 速度に比例する空気抵抗 + 回転（裏表の反転を cos で表す）
//   ・揺れ: 減衰する正弦波 A·e^(-ζωt)·sin(ωt)
// 学習記録（経験値・レベル・連続日数・今日の回数・最高記録）は端末内（chrome.storage.local の fxProgress）にだけ保存する。
(() => {
  const PALETTE = ['#4f46e5', '#0ea5e9', '#14b8a6', '#f59e0b', '#f43f5e', '#8b5cf6'];
  const DAILY_GOAL = 20;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let level = 'full'; // 'off' | 'subtle' | 'full'
  let soundOn = false;
  let progress = null;
  let session = null;
  let hud = null;

  const motion = () => (level === 'off' ? 'off' : reducedMotion ? 'off' : level);

  chrome.storage.local.get(['displayConfig', 'fxProgress'], (res) => {
    const display = res.displayConfig || {};
    level = ['off', 'subtle', 'full'].includes(display.fx) ? display.fx : 'full';
    soundOn = display.fxSound === true;
    progress = normalizeProgress(res.fxProgress);
    renderHud();
  });

  // ---------- 物理: ばね ----------
  // 半陰的オイラー法で 1/240 秒刻みに積分する（フレームレートに左右されない）。
  function spring({ from = 0, to = 1, velocity = 0, stiffness = 260, damping = 20, onUpdate, precision = 0.001 }) {
    return new Promise((resolve) => {
      if (motion() === 'off') { onUpdate(to); resolve(); return; }
      let x = from;
      let v = velocity;
      let last = performance.now();
      const step = 1 / 240;
      const tick = (now) => {
        let dt = Math.min(0.064, (now - last) / 1000);
        last = now;
        while (dt > 0) {
          const h = Math.min(step, dt);
          v += (-stiffness * (x - to) - damping * v) * h;
          x += v * h;
          dt -= h;
        }
        onUpdate(x);
        if (Math.abs(v) < precision && Math.abs(x - to) < precision) { onUpdate(to); resolve(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // 臨界減衰（行き過ぎずに最短で目標へ）: c = 2√k
  const critical = (k) => 2 * Math.sqrt(k);

  // ---------- 物理: 減衰振動の揺れ ----------
  function shake(el, { amplitude = 7, frequency = 9, zeta = 0.22, duration = 520 } = {}) {
    if (motion() !== 'full' || !el) return;
    const start = performance.now();
    const w = 2 * Math.PI * frequency;
    const tick = (now) => {
      const t = (now - start) / 1000;
      if (t * 1000 > duration) { el.style.translate = ''; return; }
      const x = amplitude * Math.exp(-zeta * w * t) * Math.sin(w * t);
      el.style.translate = `${x.toFixed(2)}px 0`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- 物理: 紙片・粒子 ----------
  let canvas = null;
  let ctx = null;
  let particles = [];
  let running = false;

  function ensureCanvas() {
    if (canvas) return;
    canvas = document.createElement('canvas');
    canvas.className = 'fx-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = innerWidth * dpr;
      canvas.height = innerHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    addEventListener('resize', resize);
  }

  // kind: 'confetti'（長方形の紙片。ひらひら落ちる）/ 'spark'（小さな光の粒。空気抵抗が大きく、すぐ止まる）/ 'dust'（ハンコの衝撃で広がる輪）
  function burst(x, y, { count = 24, kind = 'confetti', speed = 520, spread = Math.PI * 0.9, angle = -Math.PI / 2, gravity = 1500, colors = PALETTE } = {}) {
    if (motion() !== 'full') return;
    ensureCanvas();
    for (let i = 0; i < count; i++) {
      const a = kind === 'dust' ? (i / count) * Math.PI * 2 : angle + (Math.random() - 0.5) * spread;
      const s = speed * (kind === 'dust' ? 0.85 + Math.random() * 0.3 : 0.45 + Math.random() * 0.75);
      particles.push({
        kind, x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        drag: kind === 'confetti' ? 2.2 : kind === 'spark' ? 5.5 : kind === 'mote' ? 1.1 : 7.5,
        gravity: kind === 'dust' ? 0 : gravity,
        phase: Math.random() * Math.PI * 2,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 14,
        tilt: Math.random() * Math.PI * 2,
        vtilt: 6 + Math.random() * 8,
        w: kind === 'confetti' ? 6 + Math.random() * 5 : 3 + Math.random() * 2.5,
        h: kind === 'confetti' ? 9 + Math.random() * 7 : 0,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0,
        maxLife: kind === 'confetti' ? 1.6 + Math.random() * 0.8 : kind === 'spark' ? 0.55 + Math.random() * 0.3 : kind === 'mote' ? 2.0 + Math.random() * 1.2 : 0.5,
      });
    }
    if (!running) {
      running = true;
      let last = performance.now();
      const tick = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        ctx.clearRect(0, 0, innerWidth, innerHeight);
        particles = particles.filter((p) => {
          p.life += dt;
          if (p.life > p.maxLife || p.y > innerHeight + 40) return false;
          // 空気抵抗（速度に比例）: v ← v·e^(-k·dt)。紙片は向きで抵抗が変わるので、ひらひらと横に揺れる。
          const decay = Math.exp(-p.drag * dt);
          p.vx *= decay;
          p.vy = p.vy * decay + p.gravity * dt * (p.kind === 'confetti' ? 0.35 + 0.65 * Math.abs(Math.cos(p.tilt)) : 1);
          if (p.kind === 'confetti') p.vx += Math.sin(p.tilt) * 40 * dt;
          // 光の粒は浮力で昇り、ゆらぎながら漂う
          if (p.kind === 'mote') p.vx += Math.sin(p.life * 3 + p.phase) * 30 * dt;
          p.x += p.vx * dt;
          p.y += p.vy * dt;
          p.rot += p.vr * dt;
          p.tilt += p.vtilt * dt;
          const fade = Math.min(1, (p.maxLife - p.life) / (p.maxLife * 0.35));
          ctx.globalAlpha = Math.max(0, fade);
          ctx.fillStyle = p.color;
          ctx.save();
          ctx.translate(p.x, p.y);
          if (p.kind === 'confetti') {
            ctx.rotate(p.rot);
            ctx.scale(1, Math.cos(p.tilt)); // 裏返る紙片
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          } else if (p.kind === 'mote') {
            const r = p.w * (0.7 + 0.3 * Math.sin(p.life * 9 + p.phase));
            const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 4);
            glow.addColorStop(0, '#ffffff');
            glow.addColorStop(0.25, p.color);
            glow.addColorStop(1, 'rgba(255, 236, 179, 0)');
            ctx.fillStyle = glow;
            ctx.beginPath();
            ctx.arc(0, 0, r * 4, 0, Math.PI * 2);
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(0, 0, p.w * (p.kind === 'dust' ? 1 - p.life / p.maxLife * 0.5 : 1), 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
          return true;
        });
        ctx.globalAlpha = 1;
        if (particles.length) requestAnimationFrame(tick);
        else { running = false; ctx.clearRect(0, 0, innerWidth, innerHeight); }
      };
      requestAnimationFrame(tick);
    }
  }

  function centerOf(el) {
    const r = el?.getBoundingClientRect?.();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
  }

  // ---------- 音（Web Audio で合成。既定はオフ） ----------
  let audio = null;
  const PENTATONIC = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98, 1760.0];

  function tone(freq, { at = 0, duration = 0.28, type = 'sine', gain = 0.12, slideTo = 0, attack = 0.006, detune = 0 } = {}) {
    if (!soundOn || level === 'off') return;
    try {
      audio = audio || new AudioContext();
      const t = audio.currentTime + at;
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      osc.detune.setValueAtTime(detune, t);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + duration);
      amp.gain.setValueAtTime(0.0001, t);
      amp.gain.exponentialRampToValueAtTime(gain, t + attack);
      amp.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(amp).connect(audio.destination);
      osc.start(t);
      osc.stop(t + duration + 0.02);
    } catch {}
  }

  const sounds = {
    ping: (n) => { const f = PENTATONIC[Math.min(PENTATONIC.length - 1, n)]; tone(f); tone(f * 2, { gain: 0.03, duration: 0.18 }); },
    soft: () => tone(392, { duration: 0.22, type: 'triangle', gain: 0.08 }),
    stamp: () => { tone(150, { duration: 0.22, slideTo: 55, gain: 0.25 }); tone(2400, { duration: 0.05, type: 'square', gain: 0.02 }); },
    fanfare: () => [0, 2, 4, 7].forEach((n, i) => tone(PENTATONIC[n], { at: i * 0.09, duration: 0.35 })),
    // 下がっていく2音
    down: () => { tone(330, { duration: 0.18, type: 'triangle', gain: 0.07 }); tone(247, { at: 0.12, duration: 0.3, type: 'triangle', gain: 0.07, slideTo: 196 }); },
    // 聖歌隊のような和音（ゆっくり立ち上がり、わずかにずらした音を重ねて広がりを出す）＋高いきらめき
    choir: () => {
      [261.63, 329.63, 392.0, 493.88, 523.25].forEach((f, i) => {
        tone(f, { at: i * 0.05, duration: 2.4, attack: 0.35, gain: 0.05, detune: -7 });
        tone(f, { at: i * 0.05, duration: 2.4, attack: 0.35, gain: 0.05, detune: 7 });
      });
      [2093, 2637, 3136, 2637, 3520].forEach((f, i) => tone(f, { at: 0.5 + i * 0.12, duration: 0.6, gain: 0.015 }));
    },
  };

  // ---------- 学習記録 ----------
  const xpForLevel = (lv) => Math.round(80 * Math.pow(lv, 1.35)); // そのレベルから次のレベルまでに必要な経験値

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function normalizeProgress(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    return {
      xp: Math.max(0, Number(p.xp) || 0),
      level: Math.max(1, Number(p.level) || 1),
      streak: Math.max(0, Number(p.streak) || 0),
      lastDay: typeof p.lastDay === 'string' ? p.lastDay : '',
      todayDate: typeof p.todayDate === 'string' ? p.todayDate : '',
      todayCount: Math.max(0, Number(p.todayCount) || 0),
      best: p.best && typeof p.best === 'object' ? p.best : {},
    };
  }

  function daysBetween(a, b) {
    return Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);
  }

  let saveQueue = Promise.resolve();
  function saveProgress() {
    const snapshot = { ...progress };
    saveQueue = saveQueue.then(() => chrome.storage.local.set({ fxProgress: snapshot })).catch(() => {});
  }

  // 経験値を加え、レベルアップしたら true を返す
  function addXp(amount) {
    if (!progress) progress = normalizeProgress(null);
    const day = today();
    if (progress.lastDay !== day) {
      progress.streak = progress.lastDay && daysBetween(progress.lastDay, day) === 1 ? progress.streak + 1 : 1;
      progress.lastDay = day;
    }
    if (progress.todayDate !== day) { progress.todayDate = day; progress.todayCount = 0; }
    progress.todayCount += 1;
    progress.xp += amount;
    let leveled = false;
    while (progress.xp >= xpForLevel(progress.level)) {
      progress.xp -= xpForLevel(progress.level);
      progress.level += 1;
      leveled = true;
    }
    saveProgress();
    return leveled;
  }

  // ---------- 表示部品（HUD: レベル・経験値バー・連続日数・今日の目標リング） ----------
  function renderHud() {
    if (!hud || !progress) return;
    const goal = progress.todayDate === today() ? progress.todayCount : 0;
    const streak = progress.lastDay && daysBetween(progress.lastDay, today()) <= 1 ? progress.streak : 0;
    hud.querySelector('.fx-level').textContent = `Lv ${progress.level}`;
    hud.querySelector('.fx-streak').textContent = streak ? `🔥 ${streak}日` : '';
    hud.querySelector('.fx-goal-text').textContent = `${Math.min(goal, DAILY_GOAL)}/${DAILY_GOAL}`;
    hud.title = `経験値 ${progress.xp} / ${xpForLevel(progress.level)}・今日 ${goal}問（目標 ${DAILY_GOAL}問）`;
    animateBar(progress.xp / xpForLevel(progress.level));
    animateRing(Math.min(1, goal / DAILY_GOAL));
  }

  let barValue = 0;
  let barVelocity = 0;
  let barToken = 0;
  function animateBar(target) {
    const fill = hud?.querySelector('.fx-xp-fill');
    if (!fill) return;
    const token = ++barToken;
    spring({ from: barValue, to: target, velocity: barVelocity, stiffness: 120, damping: critical(120) * 0.75,
      onUpdate: (x) => { if (token !== barToken) return; barValue = x; fill.style.transform = `scaleX(${Math.max(0, Math.min(1.04, x))})`; } });
  }

  let ringValue = 0;
  function animateRing(target) {
    const arc = hud?.querySelector('.fx-goal-arc');
    if (!arc) return;
    const length = 2 * Math.PI * 9;
    arc.style.strokeDasharray = `${length}`;
    spring({ from: ringValue, to: target, stiffness: 90, damping: critical(90),
      onUpdate: (x) => { ringValue = x; arc.style.strokeDashoffset = `${length * (1 - Math.max(0, Math.min(1, x)))}`; } });
  }

  function mountHud(container) {
    if (!container) return;
    hud = document.createElement('div');
    hud.className = 'fx-hud';
    hud.innerHTML = `
      <span class="fx-level"></span>
      <span class="fx-xp" aria-hidden="true"><span class="fx-xp-fill"></span></span>
      <span class="fx-streak"></span>
      <svg class="fx-goal" viewBox="0 0 24 24" aria-hidden="true"><circle class="fx-goal-track" cx="12" cy="12" r="9"/><circle class="fx-goal-arc" cx="12" cy="12" r="9"/></svg>
      <span class="fx-goal-text"></span>`;
    container.appendChild(hud);
    renderHud();
  }

  // 要素をばねで弾ませて出す（scale 0.6 → 1、少し行き過ぎて戻る）
  function pop(el, { from = 0.6, stiffness = 380, damping = 17 } = {}) {
    if (!el) return Promise.resolve();
    el.style.opacity = '1';
    return spring({ from, to: 1, stiffness, damping, onUpdate: (s) => { el.style.scale = `${s}`; } });
  }

  // 浮かび上がって消える文字（+10 XP、COMBO など）。上向きの初速と重力で放物線を描く。
  function floatText(text, x, y, { className = '', big = false } = {}) {
    if (motion() === 'off') return;
    const el = document.createElement('div');
    el.className = `fx-float ${className}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (big) el.style.fontSize = '30px';
    document.body.appendChild(el);
    const start = performance.now();
    const v0 = big ? -260 : -170;
    const g = 260;
    const tick = (now) => {
      const t = (now - start) / 1000;
      const dy = v0 * t + 0.5 * g * t * t;
      el.style.translate = `-50% ${dy.toFixed(1)}px`;
      el.style.opacity = String(Math.max(0, 1 - Math.pow(t / 1.1, 3)));
      if (t < 1.1) requestAnimationFrame(tick); else el.remove();
    };
    requestAnimationFrame(tick);
    if (motion() === 'full') spring({ from: 0.4, to: 1, stiffness: 420, damping: 15, onUpdate: (s) => { el.style.scale = `${s}`; } });
  }

  // レベルアップ = アセンション。下から光が満ち、光の筋が回り、光の輪が広がり、光の粒が浮力で昇っていく。
  //   光の強さ: 臨界減衰のばねで 0→1、その後ゆっくり減衰 / 光の筋の回転: 角速度 ω(t) = ω0·e^(-t/τ)
  //   光の輪: 行き過ぎるばねで広がる / 粒: 負の重力（浮力）＋空気抵抗
  function levelUp(card) {
    const badge = hud?.querySelector('.fx-level');
    if (badge && motion() !== 'off') spring({ from: 2.2, to: 1, stiffness: 260, damping: 11, onUpdate: (s) => { badge.style.scale = `${s}`; } });
    if (motion() === 'off') return;
    sounds.choir();
    const veil = document.createElement('div');
    veil.className = 'fx-ascend';
    veil.setAttribute('aria-live', 'polite');
    veil.innerHTML = `
      <div class="fx-ascend-light"></div>
      <div class="fx-ascend-rays"></div>
      <div class="fx-ascend-halo"></div>
      <div class="fx-ascend-text"><div class="fx-ascend-word">ASCENSION</div><div class="fx-ascend-level">Lv ${progress.level}</div></div>`;
    document.body.appendChild(veil);
    const light = veil.querySelector('.fx-ascend-light');
    const rays = veil.querySelector('.fx-ascend-rays');
    const halo = veil.querySelector('.fx-ascend-halo');
    const text = veil.querySelector('.fx-ascend-text');
    const full = motion() === 'full';
    if (!full) { rays.remove(); halo.remove(); }
    const start = performance.now();
    const DURATION = 2.9;
    let intensity = 0;
    let vIntensity = 0;
    let angle = 0;
    let last = start;
    const tick = (now) => {
      const t = (now - start) / 1000;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      // 光: 前半は 1 を目標にした臨界減衰、後半は 0 へ
      const target = t < DURATION - 0.9 ? 1 : 0;
      const k = target ? 40 : 14;
      vIntensity += (-k * (intensity - target) - critical(k) * vIntensity) * dt;
      intensity += vIntensity * dt;
      const a = Math.max(0, Math.min(1, intensity));
      veil.style.opacity = String(a);
      light.style.transform = `translateY(${(1 - a) * 18}%) scale(${0.9 + a * 0.15})`;
      if (full) {
        angle += 1.6 * Math.exp(-t / 1.4) * dt + 0.05 * dt;
        rays.style.transform = `translate(-50%, -50%) rotate(${angle}rad) scale(${0.85 + a * 0.25})`;
      }
      if (t < DURATION) requestAnimationFrame(tick); else veil.remove();
    };
    requestAnimationFrame(tick);
    if (full) {
      spring({ from: 0.2, to: 1, stiffness: 70, damping: 7, onUpdate: (s) => { halo.style.transform = `translate(-50%, -50%) scale(${s})`; halo.style.opacity = String(Math.max(0, Math.min(1, 1.6 - s))); } });
      const cx = innerWidth / 2;
      const cy = innerHeight * 0.46;
      const gold = ['#fde68a', '#fcd34d', '#fff7d6', '#fbbf24'];
      burst(cx, innerHeight + 10, { count: 60, kind: 'mote', speed: 260, spread: Math.PI * 0.5, angle: -Math.PI / 2, gravity: -240, colors: gold });
      setTimeout(() => burst(cx, cy, { count: 40, kind: 'mote', speed: 340, spread: Math.PI * 2, gravity: -160, colors: gold }), 380);
    }
    text.style.opacity = '0';
    setTimeout(() => {
      text.style.opacity = '1';
      spring({ from: 0.7, to: 1, stiffness: 120, damping: 14, onUpdate: (s) => { text.style.transform = `translate(-50%, -50%) scale(${s})`; text.style.letterSpacing = `${0.32 + (1 - s) * 0.6}em`; } });
    }, 250);
  }

  // ---------- セッション ----------
  function clearCombo() {
    document.querySelectorAll('.fx-combo').forEach((el) => el.remove());
  }

  function startSession(kind) {
    clearCombo();
    session = { kind, start: Date.now(), answered: 0, xp: 0, combo: 0, maxCombo: 0, ranks: [] };
  }

  function award(amount, anchorEl, card, { label = '', sound = 'ping' } = {}) {
    if (!session) startSession('word');
    session.answered += 1;
    session.combo += 1;
    session.maxCombo = Math.max(session.maxCombo, session.combo);
    session.xp += amount;
    const leveled = addXp(amount);
    renderHud();
    const { x, y } = centerOf(anchorEl);
    if (sound === 'ping') sounds.ping(Math.min(9, session.combo - 1)); else sounds.soft();
    floatText(`+${amount} XP${label ? `  ${label}` : ''}`, x, y - 18);
    // コンボが続くほど紙片が増える（5の倍数で大きく）
    const milestone = session.combo % 5 === 0;
    burst(x, y, { count: milestone ? 34 : Math.min(8 + session.combo * 2, 22), kind: milestone ? 'confetti' : 'spark', speed: milestone ? 600 : 360 });
    if (session.combo >= 3) showCombo(card);
    if (leveled) setTimeout(() => levelUp(card), 260);
  }

  // 「忘れた」「難しい」・作文のC: コンボが途切れる。文字は重力で下へ落ち、カードは一瞬沈んでばねで戻る。
  function downgrade(amount, anchorEl, card, { label = 'DOWNGRADE' } = {}) {
    if (!session) startSession('word');
    const broken = session.combo;
    session.answered += 1;
    session.combo = 0;
    session.xp += amount;
    const leveled = addXp(amount);
    renderHud();
    sounds.down();
    const comboEl = card?.querySelector('.fx-combo');
    if (comboEl) {
      comboEl.classList.add('is-broken');
      comboEl.textContent = `${broken} COMBO ✕`;
      setTimeout(() => comboEl.remove(), 650);
    }
    if (motion() !== 'off') {
      const { x, y } = centerOf(anchorEl);
      sinkText(`▼ ${label}${amount ? `  +${amount} XP` : ''}`, x, y - 10);
      if (card) spring({ from: 0, to: 0, velocity: 120, stiffness: 260, damping: 16, onUpdate: (d) => { card.style.translate = `0 ${d.toFixed(2)}px`; } }).then(() => { card.style.translate = ''; });
    }
    if (leveled) setTimeout(() => levelUp(card), 260);
  }

  // 下へ落ちていく文字（初速は上向き少し、重力で下へ。色は灰色）
  function sinkText(text, x, y) {
    const el = document.createElement('div');
    el.className = 'fx-float fx-float-down';
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    document.body.appendChild(el);
    const start = performance.now();
    const tick = (now) => {
      const t = (now - start) / 1000;
      const dy = -40 * t + 0.5 * 420 * t * t;
      el.style.translate = `-50% ${dy.toFixed(1)}px`;
      el.style.opacity = String(Math.max(0, 1 - Math.pow(t / 0.95, 2)));
      if (t < 0.95) requestAnimationFrame(tick); else el.remove();
    };
    requestAnimationFrame(tick);
  }

  function showCombo(card) {
    if (motion() === 'off' || !card) return;
    let el = card.querySelector('.fx-combo');
    if (!el) {
      el = document.createElement('div');
      el.className = 'fx-combo';
      card.appendChild(el);
    }
    el.textContent = `${session.combo} COMBO`;
    el.classList.toggle('is-hot', session.combo >= 10);
    pop(el, { from: 1.5, stiffness: 520, damping: 16 });
  }

  // 作文テストのハンコ。高いところから落ちてきて（大きく → 1倍）、着地の衝撃でカードが揺れ、ほこりが輪になって広がる。
  function stamp(container, rank, card) {
    const el = document.createElement('div');
    el.className = `fx-stamp fx-rank-${rank.toLowerCase()}`;
    el.innerHTML = `<span>${rank}</span>`;
    container.appendChild(el);
    if (motion() === 'off') return;
    el.style.scale = '2.6';
    el.style.opacity = '0';
    setTimeout(() => {
      el.style.opacity = '1';
      let landed = false;
      spring({ from: 2.6, to: 1, stiffness: 520, damping: 26, onUpdate: (s) => {
        el.style.scale = `${s}`;
        if (!landed && s <= 1.02) {
          landed = true;
          sounds.stamp();
          shake(card, { amplitude: rank === 'S' ? 9 : 5 });
          const { x, y } = centerOf(el);
          burst(x, y, { count: 18, kind: 'dust', speed: 260, colors: ['#cbd5e1', '#94a3b8'] });
          if (rank === 'S') burst(x, y, { count: 48, kind: 'confetti', speed: 680 });
        }
      } });
    }, 140);
  }

  // 結果画面。数字は臨界減衰のばねで 0 から増える。
  function result(container, { title, rows, xpGained, bestKey }) {
    clearCombo();
    const elapsed = session ? Math.round((Date.now() - session.start) / 1000) : 0;
    const maxCombo = session?.maxCombo || 0;
    const best = Number(progress?.best?.[bestKey]) || 0;
    const isRecord = xpGained > 0 && xpGained > best;
    if (isRecord && progress) { progress.best = { ...progress.best, [bestKey]: xpGained }; saveProgress(); }
    container.innerHTML = `
      <div class="fx-result">
        <div class="fx-result-title">${title}</div>
        <div class="fx-result-xp"><span class="fx-count">0</span><small> XP</small></div>
        ${isRecord ? '<div class="fx-record">NEW RECORD</div>' : best ? `<div class="fx-best">最高記録 ${best} XP</div>` : ''}
        <dl class="fx-result-grid">
          ${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}
          <div><dt>最大コンボ</dt><dd>${maxCombo}</dd></div>
          <div><dt>かかった時間</dt><dd>${Math.floor(elapsed / 60)}分${String(elapsed % 60).padStart(2, '0')}秒</dd></div>
        </dl>
      </div>`;
    const count = container.querySelector('.fx-count');
    spring({ from: 0, to: xpGained, stiffness: 30, damping: critical(30), precision: 0.4, onUpdate: (x) => { count.textContent = String(Math.round(x)); } });
    const record = container.querySelector('.fx-record');
    if (record) {
      record.style.opacity = '0';
      setTimeout(() => {
        pop(record, { from: 2, stiffness: 420, damping: 14 });
        sounds.fanfare();
        const { x, y } = centerOf(record);
        burst(x, y, { count: 60, kind: 'confetti', speed: 720, spread: Math.PI * 1.1 });
      }, 700);
    } else if (xpGained > 0) {
      const { x, y } = centerOf(count);
      setTimeout(() => burst(x, y, { count: 26, kind: 'spark', speed: 420, spread: Math.PI * 2, gravity: 200 }), 500);
    }
    session = null;
  }

  window.ReadAnkiFX = {
    mountHud,
    startSession,
    award,
    downgrade,
    resetCombo: () => { if (session) session.combo = 0; clearCombo(); },
    stamp,
    result,
    shake,
    burst,
    pop,
    get session() { return session; },
  };
})();

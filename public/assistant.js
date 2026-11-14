// TX Case Desk — Case Desk Assistant (read-only) and the daily brief on Today.
// The button lives in the top bar (its own space: it never covers tabs, buttons or cards). Tapping it opens the assistant
// already knowing the page: a side panel on desktop, a full-screen sheet on phones. Open/closed is remembered per person.
// Uses helpers from app.js: $, $$, esc, api, toast, me, tab, ic, nav, closeSheet.
(() => {
  const NAME = "Case Desk Assistant";
  const wide = () => window.matchMedia("(min-width:1000px)").matches;
  const S = { open: false, thread: null, threadCase: null, msgs: [], busy: false, view: "chat", restored: false };
  let panel = null;

  // ---------- the assistant's language (Steve, Nov 13 2026): one setting per person, remembered on every device ----------
  // It changes the answers (the server tells the AI), listening, the voice, the panel's own words and the daily brief.
  // English and Spanish at launch. The rest of the app stays English.
  const LANG = { en: { name: "English", code: "en-US", other: "inglés" }, es: { name: "Español", code: "es-US", other: "Spanish" } };
  const lang = () => (me && me.prefs && me.prefs.assistant_language === "es") ? "es" : "en";
  const I18N = {
    en: { title: "Assistant", full: "Case Desk ", newBtn: "New", newTip: "Start a new conversation", hist: "History", histTip: "Saved conversations", back: "Back", close: "Close the assistant",
      ask: "Ask the assistant", placeholder: "Ask about your cases, deadlines, to-dos…", send: "Send", end: "End", talk: "Talk to the assistant", talkTip: "Talk: it answers out loud",
      optTip: "Assistant options: voice on/off, which voice, speed, answer length", options: "Assistant options", voiceWord: "Voice ", on: "on", off: "off",
      optLabel: on => `Voice ${on ? "on" : "off"}, assistant options`,
      langBtn: "EN, assistant language: English", langLegend: "Assistant language", langHint: "Answers, listening, the voice and these buttons switch to the language you pick. The rest of the app stays in English.", done: "Done",
      langNow: n => `Assistant language: ${n}`, language: "Language",
      sListen: "Listening… just talk. It sends when you stop.", sThink: "Looking that up…", sSpeak: "Answering out loud. Tap ■ to cut in.",
      aListen: "Stop listening and send", aSpeak: "Stop talking and listen", aThink: "Stop the voice conversation",
      talkHear: "Talk and hear answers", talkHint: "Mic to ask out loud; answers are read to you.", hearHint: "Answers can be read to you.",
      voice: "Voice", auto: "Automatic (best on this device)", missing: n => `Your chosen voice (${n}) isn't on this device, so the best one here is used.`,
      noVoices: "This device hasn't listed its voices yet. The best one is used automatically.",
      noLangVoice: "This device has no English voice, so answers are shown but may not be read out well.",
      speed: "Speed", rates: ["Slower", "Normal", "Faster", "Fastest"], answers: "Answers", lens: ["Short summary", "Normal", "Full detail"],
      lenHint: "How long the assistant's answers are, typed or spoken. Spoken answers stay short unless you pick Full detail.", sample: "Hear a sample",
      sampleText: "This is how the Case Desk Assistant will sound when it reads your answers.",
      engine: "Voice engine", engDevice: "This device's voices (free)", engNatural: "Natural voices: Kokoro", engOff: " (not switched on yet)",
      natHint: "Same voices as Pentex University. The answer text (social security numbers removed) goes to DeepInfra, our voice service, to be spoken.",
      natEn: "English", natEs: "Spanish (used for answers in Spanish)", natUse: " Using this device's voice.", natPlay: "This device couldn't play the natural voice.", natTap: "Tap the speaker to hear it (this device blocked the sound).",
      noSay: "This browser can't read answers out loud; the answer is on screen.", wait: "Wait for the answer to finish, then tap the mic.",
      micBlocked: "Allow the microphone for this site in your browser settings, then tap the mic.", noMic: "No microphone found. Plug one in or check your settings, then tap the mic.",
      noNet: "Speech recognition needs an internet connection. Tap the mic to try again.", heardNothing: "Didn't hear anything. Tap the mic to talk.",
      micFail: "The microphone didn't start. Tap the mic to try again.", needBrowser: "Talking to the assistant needs Chrome, Edge or Safari.",
      noAnswerVoice: "The assistant didn't answer. Tap the mic to try again.", readOut: "Read this answer out loud", readOutTip: "Read out loud", stopRead: "Stop reading",
      emptyCase: "Ask about this case: what's due, the last conversation, who opposing counsel is, new court emails.",
      empty: `Ask about your cases: "what's due this week?", "which cases have no next court date?", "any new court emails?". I read your data, and I can move a date or a to-do once you confirm. I can't send anything.`,
      emptyMic: " Or tap the mic and just talk: it answers out loud.", lookingAt: "Looking at:", thisCase: "this case", screen: "Screen:",
      loading: "Loading…", histHint: "Your saved conversations. Only you see them; your firm admin can delete them.", conv: "Conversation", del: "Delete", delAria: "Delete this conversation",
      tapAgain: "Tap again", noConv: "No saved conversations yet.", delAll: "Delete all my conversations", delAllAgain: "Tap again to delete all",
      signup: "Sign up", openFirm: "Open Firm Settings → AI (Claude)", aiDown: "The AI service didn't answer.",
      types: { hearing: "Court date", deadline: "Deadline", meeting: "Meeting", event: "Calendar item", todo: "To-do" }, item: "Item", dueDate: " due date", noDate: "no date", to: " to ",
      wHearing: "This moves it in TX Case Desk only. It doesn't change the court's setting: file a motion or notice to reset it.",
      wDeadline: "Check the new date against the rules and any court order. It will show as not confirmed until you confirm it on the calendar.",
      weekend: d => `The new date is a ${d ? "Saturday" : "Sunday"}.`, confirm: "Confirm", cancel: "Cancel", orSay: `or say "confirm"`,
      pMoved: "✓ Moved.", pCancelled: "Cancelled. Nothing changed.", pExpired: "Expired. Nothing changed; ask again if you still want it.", confirmAll: n => `Confirm all ${n}`,
      movedN: n => n > 1 ? `Moved ${n} dates.` : "Moved.", movedLater: "Moved. Your screen shows it next time you open it.", failed: "That didn't work.",
      brief: "Daily brief", genBrief: "Generate brief", refresh: "Refresh", writing: "Writing…", briefWritten: t => `Written ${t} from your calendar, to-dos and court email.`,
      briefIntro: "Court dates, deadlines, overdue to-dos and new court emails since yesterday, in a few lines. Choose Generate brief.",
      demoOff: "The demo's AI isn't switched on yet.", addKey: "Add your firm's Claude key in Firm Settings." },
    es: { title: "Asistente", full: "", newBtn: "Nueva", newTip: "Empezar una conversación nueva", hist: "Historial", histTip: "Conversaciones guardadas", back: "Volver", close: "Cerrar el asistente",
      ask: "Pregunte al asistente", placeholder: "Pregunte por sus casos, plazos, tareas…", send: "Enviar", end: "Terminar", talk: "Hablar con el asistente", talkTip: "Hable: le contesta en voz alta",
      optTip: "Opciones del asistente: voz sí/no, qué voz, velocidad, largo de las respuestas", options: "Opciones del asistente", voiceWord: "Voz ", on: "sí", off: "no",
      optLabel: on => `Voz ${on ? "sí" : "no"}, opciones del asistente`,
      langBtn: "ES, idioma del asistente: español", langLegend: "Idioma del asistente", langHint: "Las respuestas, lo que escucha, la voz y estos botones cambian al idioma que elija. El resto de la aplicación sigue en inglés.", done: "Listo",
      langNow: n => `Idioma del asistente: ${n}`, language: "Idioma",
      sListen: "Escuchando… hable. Se envía cuando deje de hablar.", sThink: "Buscándolo…", sSpeak: "Contestando en voz alta. Toque ■ para interrumpir.",
      aListen: "Dejar de escuchar y enviar", aSpeak: "Dejar de hablar y escuchar", aThink: "Terminar la conversación por voz",
      talkHear: "Hablar y escuchar las respuestas", talkHint: "Micrófono para preguntar en voz alta; las respuestas se leen en voz alta.", hearHint: "Las respuestas se pueden leer en voz alta.",
      voice: "Voz", auto: "Automática (la mejor de este dispositivo)", missing: n => `La voz que eligió (${n}) no está en este dispositivo, así que se usa la mejor que hay aquí.`,
      noVoices: "Este dispositivo todavía no muestra sus voces. Se usa la mejor automáticamente.",
      noLangVoice: "Este dispositivo no tiene una voz en español: las respuestas se muestran en pantalla, pero puede que no se lean bien en voz alta.",
      speed: "Velocidad", rates: ["Más lenta", "Normal", "Más rápida", "La más rápida"], answers: "Respuestas", lens: ["Resumen corto", "Normal", "Todo el detalle"],
      lenHint: "Qué tan largas son las respuestas, escritas o habladas. Las habladas son cortas a menos que elija Todo el detalle.", sample: "Escuchar una muestra",
      sampleText: "Así sonará el asistente de Case Desk cuando lea sus respuestas.",
      engine: "Motor de voz", engDevice: "Voces de este dispositivo (gratis)", engNatural: "Voces naturales: Kokoro", engOff: " (todavía no activadas)",
      natHint: "Las mismas voces que Pentex University. El texto de la respuesta (sin números de seguro social) va a DeepInfra, nuestro servicio de voz, para leerlo.",
      natEn: "Inglés", natEs: "Español (para las respuestas en español)", natUse: " Se usa la voz de este dispositivo.", natPlay: "Este dispositivo no pudo reproducir la voz natural.", natTap: "Toque el altavoz para oírla (este dispositivo bloqueó el sonido).",
      noSay: "Este navegador no puede leer las respuestas en voz alta; la respuesta está en pantalla.", wait: "Espere a que termine la respuesta y luego toque el micrófono.",
      micBlocked: "Permita el micrófono para este sitio en la configuración del navegador y luego toque el micrófono.", noMic: "No se encontró un micrófono. Conecte uno o revise la configuración y luego toque el micrófono.",
      noNet: "El reconocimiento de voz necesita conexión a internet. Toque el micrófono para intentar de nuevo.", heardNothing: "No escuché nada. Toque el micrófono para hablar.",
      micFail: "El micrófono no se activó. Toque el micrófono para intentar de nuevo.", needBrowser: "Hablar con el asistente necesita Chrome, Edge o Safari.",
      noAnswerVoice: "El asistente no contestó. Toque el micrófono para intentar de nuevo.", readOut: "Leer esta respuesta en voz alta", readOutTip: "Leer en voz alta", stopRead: "Dejar de leer",
      emptyCase: "Pregunte por este caso: qué vence, la última conversación, quién es el abogado de la parte contraria, correos nuevos del tribunal.",
      empty: `Pregunte por sus casos: "¿qué vence esta semana?", "¿qué casos no tienen próxima fecha en el tribunal?", "¿hay correos nuevos del tribunal?". Leo sus datos y puedo mover una fecha o una tarea cuando usted lo confirme. No puedo enviar nada.`,
      emptyMic: " O toque el micrófono y hable: le contesta en voz alta.", lookingAt: "Viendo:", thisCase: "este caso", screen: "Pantalla:",
      loading: "Cargando…", histHint: "Sus conversaciones guardadas. Solo usted las ve; el administrador de su firma puede borrarlas.", conv: "Conversación", del: "Borrar", delAria: "Borrar esta conversación",
      tapAgain: "Toque otra vez", noConv: "Todavía no hay conversaciones guardadas.", delAll: "Borrar todas mis conversaciones", delAllAgain: "Toque otra vez para borrar todas",
      signup: "Registrarse", openFirm: "Abrir Firm Settings → AI (Claude)", aiDown: "El servicio de IA no contestó.",
      types: { hearing: "Audiencia", deadline: "Plazo", meeting: "Reunión", event: "Evento del calendario", todo: "Tarea" }, item: "Elemento", dueDate: " (fecha de vencimiento)", noDate: "sin fecha", to: " al ",
      wHearing: "Esto lo mueve solo en TX Case Desk. No cambia la fecha fijada por el tribunal: presente una moción o un aviso para reprogramarla.",
      wDeadline: "Verifique la nueva fecha con las reglas y cualquier orden del tribunal. Aparecerá como no confirmada hasta que la confirme en el calendario.",
      weekend: d => `La nueva fecha cae en ${d ? "sábado" : "domingo"}.`, confirm: "Confirmar", cancel: "Cancelar", orSay: `o diga "confirmar"`,
      pMoved: "✓ Movido.", pCancelled: "Cancelado. No se cambió nada.", pExpired: "Caducó. No se cambió nada; pregunte de nuevo si todavía lo quiere.", confirmAll: n => `Confirmar los ${n}`,
      movedN: n => n > 1 ? `Se movieron ${n} fechas.` : "Movido.", movedLater: "Movido. Su pantalla lo mostrará la próxima vez que la abra.", failed: "Eso no funcionó.",
      brief: "Resumen del día", genBrief: "Crear resumen", refresh: "Actualizar", writing: "Escribiendo…", briefWritten: t => `Escrito: ${t}, con su calendario, tareas y correo del tribunal.`,
      briefIntro: "Audiencias, plazos, tareas vencidas y correos nuevos del tribunal desde ayer, en pocas líneas. Elija Crear resumen.",
      demoOff: "La IA de la demostración todavía no está activada.", addKey: "Agregue la clave de Claude de su firma en Firm Settings." },
  };
  const tr = k => { const x = I18N[lang()][k]; return x === undefined ? I18N.en[k] : x; };
  // the server's plain error messages, in Spanish when that's the person's language (anything unknown stays as sent)
  // the natural voices' short descriptions, in Spanish
  const NOTE_ES = { "female, warm": "mujer, cálida", "female, bright": "mujer, clara", "female, soft": "mujer, suave", "female": "mujer", "male": "hombre", "male, deeper": "hombre, más grave",
    "male, upbeat": "hombre, animado", "female, British": "mujer, británica", "male, British": "hombre, británico", "female, Spanish": "mujer, español", "male, Spanish": "hombre, español", "male, Spanish, older": "hombre, español, mayor" };
  const ERR_ES = {
    "Add your firm's Claude key in Firm Settings.": "Agregue la clave de Claude de su firma en Firm Settings.",
    "The demo's AI isn't switched on yet. Sign up to use AI with your own firm's key.": "La IA de la demostración todavía no está activada. Regístrese para usar la IA con la clave de su propia firma.",
    "The demo's AI isn't available right now. Sign up to use AI with your own firm's key.": "La IA de la demostración no está disponible ahora. Regístrese para usar la IA con la clave de su propia firma.",
    "Key not valid. A firm admin can replace it in Firm Settings → AI (Claude).": "La clave no es válida. Un administrador de la firma puede cambiarla en Firm Settings → AI (Claude).",
    "Out of credit (add credit in the Anthropic Console).": "Sin crédito (agregue crédito en la consola de Anthropic).",
    "Too many requests, try again shortly.": "Demasiadas solicitudes; intente de nuevo en un momento.",
    "The AI service is busy, try again shortly.": "El servicio de IA está ocupado; intente de nuevo en un momento.",
    "The AI service didn't answer.": "El servicio de IA no contestó.", "The AI service took too long.": "El servicio de IA tardó demasiado.",
    "AI is off in developer view.": "La IA está apagada en la vista de desarrollador.", "The assistant is off in developer view.": "El asistente está apagado en la vista de desarrollador.",
    "Too many questions in a few minutes. Wait a little and try again.": "Demasiadas preguntas en pocos minutos. Espere un poco e intente de nuevo.",
    "The demo has used its AI allowance for now. Sign up to keep using the assistant with your own firm's key.": "La demostración ya usó su asignación de IA por ahora. Regístrese para seguir usando el asistente con la clave de su propia firma.",
    "This demo has used its AI allowance for today. Sign up to keep using the assistant with your own firm's key.": "Esta demostración ya usó su asignación de IA de hoy. Regístrese para seguir usando el asistente con la clave de su propia firma.",
    "That's a lot of AI requests in a few minutes for the demo. Wait a little, or sign up to use your own firm's key.": "Son muchas solicitudes de IA en pocos minutos para la demostración. Espere un poco o regístrese para usar la clave de su propia firma.",
    "Demo firm: that's a lot of changes for one hour. Sign up to keep going.": "Firma de demostración: son muchos cambios para una hora. Regístrese para continuar.",
    "Natural voices aren't switched on yet.": "Las voces naturales todavía no están activadas.", "Nothing to read.": "No hay nada que leer.",
    "Too much read aloud in a few minutes. Wait a little.": "Demasiada lectura en voz alta en pocos minutos. Espere un poco.",
    "Today's natural-voice allowance is used up; the device voice is used until tomorrow.": "Se acabó el uso de voces naturales de hoy; hasta mañana se usa la voz del dispositivo.",
    "The voice service didn't answer.": "El servicio de voz no contestó.", "The voice service key isn't valid.": "La clave del servicio de voz no es válida.",
    "The voice service is out of credit.": "El servicio de voz no tiene crédito.", "The voice service sent no audio.": "El servicio de voz no envió audio.",
    "Type a question first.": "Escriba una pregunta primero.", "That's too long. Ask in a shorter message.": "Es demasiado largo. Pregunte en un mensaje más corto.",
    "That conversation was deleted. Start a new one.": "Esa conversación se borró. Empiece una nueva.", "Not found": "No encontrado",
  };
  const errText = m => lang() === "es" && ERR_ES[m] ? ERR_ES[m] : m;
  window.assistLang = lang;

  // what the person is looking at (set by the case hub and the calendar sheet; cleared when the screen changes)
  window.assistCtx = { case_id: null, case_label: null, event_id: null };
  const ctxNow = () => ({ screen: (typeof titleOf === "function" ? titleOf(tab) : tab), case_id: assistCtx.case_id, event_id: assistCtx.event_id });

  // ---------- rendering answers: plain text, **bold**, "- " lists, [[case:ID]] links (only to cases the server checked) ----------
  function render(text, links) {
    const L = new Map((links || []).map(l => [+l.id, l.label]));
    const inline = s => esc(s).replace(/\*\*([^*]{1,200})\*\*/g, "<b>$1</b>")
      .replace(/\[\[case:(\d{1,9})\]\]/g, (m, id) => L.has(+id) ? `<button type="button" class="caselink" data-ascase="${+id}">${esc(L.get(+id))}</button>` : "");
    const out = []; let list = null;
    for (const line of String(text || "").split("\n")) {
      const li = line.match(/^\s*[-•*]\s+(.*)$/);
      if (li) { if (!list) { list = []; out.push(list); } list.push(inline(li[1])); continue; }
      list = null; if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    return out.map(x => Array.isArray(x) ? `<ul>${x.map(i => `<li>${i}</li>`).join("")}</ul>` : x).join("");
  }
  function wireLinks(root) {
    root.querySelectorAll("[data-ascase]").forEach(b => b.onclick = () => { if (!wide()) setOpen(false); window.caseHub && caseHub(+b.dataset.ascase); });
    root.querySelectorAll("[data-assignup]").forEach(b => b.onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); location.href = "/?signup=1"; });
    root.querySelectorAll("[data-asfirm]").forEach(b => b.onclick = () => { if (!wide()) setOpen(false); window.fsSecGo = "ai"; nav("firm"); });
  }
  // a plain error, with a Sign up button when the demo's AI allowance is used up
  const errHtml = e => `<div>${esc(errText(e.message || I18N.en.aiDown))}</div>${e.code === "DEMO_CAP" ? `<div class="row" style="margin-top:8px"><button type="button" class="btn sm" data-assignup>${esc(tr("signup"))}</button></div>`
    : e.code === "NO_KEY" && me && me.role === "admin" && !me.demo ? `<div class="row" style="margin-top:8px"><button type="button" class="btn sm ghost" data-asfirm>${esc(tr("openFirm"))}</button></div>` : ""}`;
  window.assistErrHtml = errHtml; window.assistWire = wireLinks; window.assistRender = render;

  // ---------- talking to the assistant: speak, it sends when you stop, the answer is read out loud, then it listens again ----------
  // Uses the phone's or browser's own speech (nothing extra is recorded or kept). Hands-free until End, a typed question,
  // closing the panel, or a turn where nothing is said.
  const MIC = `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0 7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 1 1 0-2h3v-2.08A7 7 0 0 1 5 12a1 1 0 1 1 2 0 5 5 0 0 0 10 0Z"/></svg>`;
  const SPK = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4Zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>`;
  const GLOBE = `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3Z"/></svg>`;
  const STOP = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;
  const VOICE = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition, syn = window.speechSynthesis;
    const V = { ok: !!SR, canSay: !!(syn && window.SpeechSynthesisUtterance), on: false, state: "idle" };
    let rec = null, gen = 0, voice = null;
    const el = id => panel && panel.querySelector(id);
    function ui(state, note) {
      V.state = state; const m = el("#asMic"), vs = el("#asVs"); if (!m || !vs) return;
      m.classList.toggle("rec", state === "listen"); m.classList.toggle("talk", state === "speak");
      m.innerHTML = state === "speak" ? STOP : MIC;
      m.setAttribute("aria-label", state === "listen" ? tr("aListen") : state === "speak" ? tr("aSpeak") : state === "think" ? tr("aThink") : tr("talk"));
      const t = { listen: tr("sListen"), think: tr("sThink"), speak: tr("sSpeak") }[state];
      vs.hidden = !(V.on && t) && !note; vs.dataset.state = state;
      el("#asVsT").textContent = note || t || ""; el("#asVsEnd").hidden = !V.on;
    }
    // the voices this device has in the assistant's language (US first, then Mexico for Spanish), or every voice if it has none; names differ per device
    const LRX = { en: [/^en/i, /^en[-_]US/i, /^en[-_]US/i], es: [/^es/i, /^es[-_]US/i, /^es[-_]MX/i] };
    V.has = () => !!syn && (syn.getVoices() || []).some(v => LRX[lang()][0].test(v.lang));
    V.list = () => { if (!syn) return []; const [any, us, mx] = LRX[lang()], all = syn.getVoices() || [], mine = all.filter(v => any.test(v.lang));
      const rank = v => us.test(v.lang) ? 0 : mx.test(v.lang) ? 1 : 2;
      return (mine.length ? mine : all).slice().sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name)); };
    const vkeyName = () => lang() === "es" ? "assistant_voice_name_es" : "assistant_voice_name";   // one chosen voice per language
    const pref = k => (me && me.prefs || {})[k];
    V.length = () => { const l = pref("assistant_length"); return l === "short" || l === "full" ? l : "normal"; };
    V.rate = () => { const r = +pref("assistant_voice_rate"); return r >= 0.7 && r <= 1.5 ? r : 1.03; };
    V.chosen = () => { const n = pref(vkeyName()); return n ? V.list().find(v => v.name === n) || null : null; };
    V.reset = () => { voice = null; };   // the language changed: pick the best voice again
    function pick() {
      const c = V.chosen(); if (c) return c;
      if (voice || !syn) return voice;
      // in tiers: US voices first (best quality, a known good name, on-device, any), then Mexico (Spanish), then the rest of the language
      const es = lang() === "es", all = syn.getVoices() || [], [any, us, mx] = LRX[lang()];
      const named = es ? /Paulina|Monica|Mónica|Google español|Sabina|Dalia|Elvira|Jorge|Juan/i : /Google US English|Samantha|Aria|Jenny/i;
      const tiers = [all.filter(v => us.test(v.lang)), es ? all.filter(v => mx.test(v.lang) && !us.test(v.lang)) : [], all.filter(v => any.test(v.lang) && !us.test(v.lang) && !mx.test(v.lang))];
      for (const t of tiers) { const v = t.find(v => /natural|neural|premium|enhanced/i.test(v.name)) || t.find(v => named.test(v.name)) || t.find(v => v.localService) || t[0]; if (v) return voice = v; }
      return voice = null;
    }
    let vkey = "";   // redraw the menu only when the voice list really changed, and never while someone is using it (an open phone picker would close)
    if (syn && syn.addEventListener) syn.addEventListener("voiceschanged", () => { voice = null;
      const k = V.list().map(v => v.name).join("|"); if (k === vkey) return; vkey = k;
      const m = el("#asVm"); if (panel && m && !m.hidden && !m.contains(document.activeElement)) V.menu(true); });
    // what is read aloud: no markdown, case links read as the case name, list items as sentences
    V.plain = (text, links) => { const L = new Map((links || []).map(l => [+l.id, l.label]));
      return String(text || "").replace(/\[\[case:(\d{1,9})\]\]/g, (m, id) => L.get(+id) || "").replace(/\*\*/g, "").replace(/^\s*[-•*]\s+(.*?)[.;:]?\s*$/gm, "$1.")
        .replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").replace(/\s+([.,;:?!])/g, "$1").trim(); };
    // long answers are read in short pieces (Chrome stops one piece after ~15 seconds). Split only at a period followed by a space,
    // so "§ 16.003" and "$1,250.50" stay whole; very long sentences break at a comma or space. (No lookbehind: older iOS can't parse it.)
    const chunks = t => t.replace(/([.!?]+["')\]]*)\s+/g, "$1\n").split("\n")
      .flatMap(s => { s = s.trim(); const o = []; while (s.length > 200) { let k = s.lastIndexOf(", ", 200); if (k < 80) k = s.lastIndexOf(" ", 200); if (k < 1) k = 200; o.push(s.slice(0, k + 1).trim()); s = s.slice(k + 1).trim(); } if (s) o.push(s); return o; })
      .reduce((o, s) => { const l = o[o.length - 1]; if (l && (l + " " + s).length < 220) o[o.length - 1] = l + " " + s; else o.push(s); return o; }, []);
    window.assistChunks = chunks;   // pure; used by the tests
    let backup = 0;
    // natural voices (Kokoro via the server): one audio player, reused so phones allow it after the first tap
    const SILENT = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    V.naturalOk = false; V.kokoro = [];
    V.engine = () => V.naturalOk && pref("assistant_voice_engine") === "natural" ? "natural" : "device";
    V.canPlay = () => V.canSay || V.engine() === "natural";
    const prime = () => { if (V.engine() !== "natural") return; if (!V.audio) V.audio = new Audio(); if (!V.primed) { try { V.audio.src = SILENT; const p = V.audio.play(); if (p && p.then) p.then(() => { V.primed = true; }, () => {}); else V.primed = true; } catch (e) {} } };   // counts only if the phone allowed it
    const stopAudio = () => { if (V.freeNat) { V.freeNat(); V.freeNat = null; } if (V.abort) { try { V.abort.abort(); } catch (e) {} V.abort = null; } if (V.audio) { try { V.audio.onended = V.audio.onerror = null; V.audio.pause(); } catch (e) {} } };
    // which Kokoro voice reads this piece: theirs, or a Spanish voice when the answer is in Spanish
    const ES = /(?:^|[^a-záéíóúñ])(el|la|los|las|que|del|por|para|usted|caso|fecha|audiencia|tiene|está|cliente|también|pero|como|sus)(?=$|[^a-záéíóúñ])/gi, EN = /\b(the|and|is|are|you|your|case|date|hearing|this|that|with|for|of)\b/gi;
    V.naturalVoice = t => { const v = pref("assistant_natural_voice") || "af_heart"; const es = (String(t).match(ES) || []).length, en = (String(t).match(EN) || []).length;
      const spanish = (es >= 3 && es > en) || (lang() === "es" && es >= 1 && es >= en);   // a Spanish assistant reads short Spanish answers in Spanish too
      if (spanish) return /^e/.test(v) ? v : /^.m_/.test(v) ? "em_alex" : "ef_dora";
      return /^e/.test(v) ? (/^em_/.test(v) ? "am_michael" : "af_heart") : v; };   // a Spanish voice reads Spanish answers only
    let warned = 0;
    function playNatural(parts, my, done, fallback) {
      const a = V.audio || (V.audio = new Audio()), ctl = V.abort = new AbortController();
      const get = t => fetch("/api/assistant/speak", { method: "POST", credentials: "same-origin", signal: ctl.signal, headers: { "Content-Type": "application/json", "X-Requested-With": "tcd" }, body: JSON.stringify({ text: t, voice: V.naturalVoice(t) }) })
        .then(async r => { if (!r.ok) { const j = await r.json().catch(() => ({})); throw Object.assign(new Error(errText(j.error || "") || errText("The voice service didn't answer.")), { code: j.code }); } return URL.createObjectURL(await r.blob()); });
      let i = 0, next = get(parts[0]), over = false;
      const free = pr => pr && pr.then(u => URL.revokeObjectURL(u), () => {});   // audio fetched but never played
      V.freeNat = () => { const n = next; next = null; free(n); };
      // once only: a bad file can fire both the error event and a refused play(), which must not read the rest twice
      const bail = e => { if (my !== gen || over) return; over = true; stopAudio(); free(next);
        if (e && e.name !== "AbortError" && Date.now() - warned > 60000) { warned = Date.now(); toast((e.message || errText("The voice service didn't answer.")) + tr("natUse")); } fallback(parts.slice(i)); };
      const step = async () => {
        let url; try { url = await next; } catch (e) { return bail(e); }
        if (my !== gen || over) { URL.revokeObjectURL(url); return; }
        if (i + 1 < parts.length) { next = get(parts[i + 1]); next.catch(() => {}); } else next = null;
        a.onended = () => { URL.revokeObjectURL(url); if (my !== gen || over) { free(next); return; } i++; if (i < parts.length) step(); else done(); };
        a.onerror = () => { URL.revokeObjectURL(url); bail(new Error(tr("natPlay"))); };
        a.src = url; try { a.playbackRate = V.rate(); } catch (e) {}
        try { await a.play(); } catch (e) { if (my === gen) bail(new Error(tr("natTap"))); }
      };
      step();
    }
    const hush = () => { clearTimeout(backup); stopAudio(); if (syn && (syn.speaking || syn.pending)) try { syn.cancel(); } catch (e) {} };
    V.replaying = false;
    V.say = (text, links, thenListen, note) => {
      if (!V.canPlay()) return thenListen && V.on ? V.end(tr("noSay")) : undefined;
      prime();   // still inside the tap when it's a replay or the mic: lets phones play the natural voice later
      if (!thenListen && V.on) V.end();   // a replay ends the hands-free conversation (and gives back a half-typed question)
      const my = ++gen; stopRec(); hush();
      const parts = chunks(V.plain(text, links)); if (!parts.length) return thenListen && V.on ? listen() : ui("idle");
      V.replaying = !thenListen; ui(thenListen ? "speak" : "idle", thenListen ? undefined : note); if (!thenListen) draw();
      const done = () => { if (my !== gen) return; gen++; clearTimeout(backup); V.q = [];
        if (V.replaying) { V.replaying = false; draw(); }
        if (thenListen && V.on && S.open) { const g = gen; setTimeout(() => g === gen && V.on && listen(), 250); } else if (!V.on) ui("idle", thenListen ? undefined : note); };
      const device = ps => {
        if (!V.canSay || !ps.length) return done();
        V.q = [];   // kept referenced: Chrome can drop an unreferenced piece and never say it finished
        ps.forEach((p, i) => { const u = new SpeechSynthesisUtterance(p); const v = pick(); if (v) u.voice = v; u.lang = v ? v.lang : LANG[lang()].code; u.rate = V.rate();
          if (i === ps.length - 1) u.onend = u.onerror = done;
          V.q.push(u); syn.speak(u); });
        // backup in case the browser never reports the end (about 90 ms a character, plus slack)
        const check = () => { if (my !== gen) return; if (syn.speaking || syn.pending) backup = setTimeout(check, 5000); else done(); };   // still reading: check again in 5 s
        backup = setTimeout(check, ps.join(" ").length * 90 + 3000);
      };
      if (V.engine() === "natural") playNatural(parts, my, done, device); else device(parts);
    };
    V.hushReplay = () => { gen++; hush(); V.replaying = false; draw(); };
    function stopRec() { clearTimeout(V.quiet); if (rec) { const r = rec; rec = null; r.onresult = r.onend = r.onerror = null; try { r.abort(); } catch (e) {} } }
    let draft = "";
    function listen(keepUnlock) {
      if (!V.on || !panel) return;
      if (S.busy) return V.end(tr("wait"));
      stopRec(); if (keepUnlock) { clearTimeout(backup); stopAudio(); } else hush(); if (V.replaying) { V.replaying = false; draw(); }   // don't cancel the silent unlock word on the first tap
      const inp = el("#asIn"), my = ++gen; if (inp.value.trim()) draft = inp.value; inp.value = "";
      const r = rec = new SR(); r.lang = LANG[lang()].code; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
      let fin = "", err = null;
      r.onresult = e => { let f = "", t = ""; for (let i = 0; i < e.results.length; i++) { const x = e.results[i][0].transcript; if (e.results[i].isFinal) f += x; else t += x; }
        fin = f; inp.value = (f + t).replace(/\s+/g, " ").trim();
        // some phones (iOS) keep listening after you go quiet: 1.5 seconds with no new words sends it
        clearTimeout(V.quiet); if (inp.value) V.quiet = setTimeout(() => { if (rec === r) try { r.stop(); } catch (x) {} }, 1500); };
      r.onerror = e => { err = e.error; };
      r.onend = () => { if (rec !== r || my !== gen) return; rec = null; clearTimeout(V.quiet);
        const text = (fin || inp.value).replace(/\s+/g, " ").trim();
        if (err === "not-allowed" || err === "service-not-allowed") return V.end(tr("micBlocked"));
        if (err === "audio-capture") return V.end(tr("noMic"));
        if (err === "network") return V.end(tr("noNet"));
        if (!text) return V.end(tr("heardNothing"));
        draft = ""; inp.value = text; ui("think"); send(true); };
      try { r.start(); ui("listen"); } catch (e) { rec = null; V.end(tr("micFail")); }
    }
    V.tap = () => {
      if (!V.ok) return toast(tr("needBrowser"));
      if (!V.enabled()) return;
      if (V.state === "listen" && rec) { try { rec.stop(); } catch (e) {} return; }      // done talking: send now
      if (V.state === "think") return V.end();                                          // waiting on an answer: stop the conversation
      // phones only allow reading aloud after a tap: a silent word now lets the answer be read later
      let first = false;
      prime();
      if (V.canSay && !V.unlocked) { try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; syn.speak(u); } catch (e) {} V.unlocked = first = true; }
      V.on = true; listen(first && V.state !== "speak" && !V.replaying);                                                             // start, or cut in while it's talking
    };
    V.end = note => { const was = V.on; V.on = false; gen++; stopRec(); hush(); V.replaying = false; ui("idle", note);
      const inp = el("#asIn"); if (was && draft && inp && !inp.value.trim()) inp.value = draft; draft = ""; };
    // phone locked or app switched: stop (reading can pause there and never finish)
    document.addEventListener("visibilitychange", () => { if (document.hidden && (V.on || V.replaying)) { V.end(); if (panel) draw(); } });
    // the on/off switch: per person, remembered on every device (off = no mic, no speaker buttons, nothing read aloud)
    V.enabled = () => !(me && me.prefs && me.prefs.assistant_voice === false);
    V.paint = () => { const t = el("#asVoice"), m = el("#asMic"), on = V.enabled();
      if (t) { t.innerHTML = `${SPK}<span><span class="vw">${esc(tr("voiceWord"))}</span>${esc(on ? tr("on") : tr("off"))}</span>`; t.classList.toggle("on", on);
        t.setAttribute("aria-label", tr("optLabel")(on)); t.setAttribute("title", tr("optTip")); t.setAttribute("aria-expanded", String(!el("#asVm").hidden)); }
      if (m) m.hidden = !on; };
    const save = (body, local) => { if (me) me.prefs = { ...(me.prefs || {}), ...local }; return api("/api/assistant/prefs", { method: "PUT", body }).catch(() => {}); };
    V.set = on => { if (!on) V.end(); save({ voice: !!on }, { assistant_voice: !!on }); draw(); V.menu(true); };
    // the Voice menu: on/off, which voice, how fast, hear a sample. Remembered per person on every device;
    // a voice another device doesn't have falls back to the best one it does have.
    const RATES = [0.85, 1.03, 1.15, 1.3];
    V.menu = keep => {
      const m = el("#asVm"); if (!m) return;
      if (!keep) { m.hidden = !m.hidden; if (m.hidden) { V.paint(); return; } } else if (m.hidden) return;
      const nat = V.engine() === "natural", es = lang() === "es";
      const on = V.enabled(), list = V.list(), want = pref(vkeyName()), have = V.chosen(), r = V.rate();
      vkey = list.map(v => v.name).join("|"); const fid = m.contains(document.activeElement) && document.activeElement.id;
      const rateNow = RATES.reduce((a, b) => Math.abs(b - r) < Math.abs(a - r) ? b : a);
      const natGroups = es ? [["es", tr("natEs")], ["en", tr("natEn")]] : [["en", tr("natEn")], ["es", tr("natEs")]];   // the assistant's language first
      m.innerHTML = `<label class="asvf"><span>${esc(tr("language"))}</span><select id="asVLang">${langOpts()}</select></label>
        <label class="asvrow"><input type="checkbox" id="asVOn" ${on ? "checked" : ""}> <span><b>${esc(tr("talkHear"))}</b><br><span class="ashint">${esc(V.ok ? tr("talkHint") : tr("hearHint"))}</span></span></label>
        ${V.canPlay() || V.naturalOk ? `<label class="asvf"><span>${esc(tr("engine"))}</span><select id="asVEng" ${on ? "" : "disabled"}>
            <option value="device" ${nat ? "" : "selected"} ${V.canSay ? "" : "disabled"}>${esc(tr("engDevice"))}</option>
            <option value="natural" ${nat ? "selected" : ""} ${V.naturalOk ? "" : "disabled"}>${esc(tr("engNatural"))}${V.naturalOk ? "" : esc(tr("engOff"))}</option></select>
          ${nat ? `<small class="ashint">${esc(tr("natHint"))}</small>` : ""}</label>` : ""}
        ${nat ? `<label class="asvf"><span>${esc(tr("voice"))}</span><select id="asVNat" ${on ? "" : "disabled"}>${natGroups.map(([lg, lab]) =>
            `<optgroup label="${esc(lab)}" lang="${lg}">${V.kokoro.filter(v => v.lang === lg).map(v => `<option value="${esc(v.id)}" ${(pref("assistant_natural_voice") || "af_heart") === v.id ? "selected" : ""}>${esc(v.name)} · ${esc(es ? (NOTE_ES[v.note] || v.note) : v.note)}</option>`).join("")}</optgroup>`).join("")}</select></label>`
        : V.canSay ? `<label class="asvf"><span>${esc(tr("voice"))}</span><select id="asVSel" ${on ? "" : "disabled"}><option value="">${esc(tr("auto"))}</option>
          ${list.map(v => `<option value="${esc(v.name)}" ${have && have.name === v.name ? "selected" : ""}>${esc(v.name.replace(/^(Microsoft|Google)\s+/, ""))} · ${esc(v.lang)}</option>`).join("")}</select></label>
        ${want && !have ? `<div class="ashint asvmiss">${esc(tr("missing")(want))}</div>` : ""}
        ${!list.length ? `<div class="ashint">${esc(tr("noVoices"))}</div>` : list.length && !V.has() ? `<div class="ashint">${esc(tr("noLangVoice"))}</div>` : ""}` : ""}
        ${V.canPlay() ? `<label class="asvf"><span>${esc(tr("speed"))}</span><select id="asVRate" ${on ? "" : "disabled"}>${RATES.map((v, i) => `<option value="${v}" ${v === rateNow ? "selected" : ""}>${esc(tr("rates")[i])}</option>`).join("")}</select></label>` : ""}
        <label class="asvf"><span>${esc(tr("answers"))}</span><select id="asVLen">${["short", "normal", "full"].map((v, i) => `<option value="${v}" ${V.length() === v ? "selected" : ""}>${esc(tr("lens")[i])}</option>`).join("")}</select>
          <small class="ashint">${esc(tr("lenHint"))}</small></label>
        <div class="row" style="gap:8px;margin-top:4px">${V.canPlay() ? `<button type="button" class="btn sm ghost" id="asVTry" ${on ? "" : "disabled"}>${esc(tr("sample"))}</button>` : ""}<button type="button" class="btn sm" id="asVDone">${esc(tr("done"))}</button></div>`;
      m.querySelector("#asVLang").onchange = e => setLang(e.target.value, "#asVLang");
      const eng = m.querySelector("#asVEng"); if (eng) eng.onchange = () => { save({ voice_engine: eng.value }, { assistant_voice_engine: eng.value }); V.menu(true); if (eng.value === "natural") V.sample(); };
      const nv = m.querySelector("#asVNat"); if (nv) nv.onchange = () => { save({ natural_voice: nv.value }, { assistant_natural_voice: nv.value }); V.sample(nv.value); };
      m.querySelector("#asVOn").onchange = e => V.set(e.target.checked);
      const sel = m.querySelector("#asVSel"); if (sel) sel.onchange = () => { voice = null; save({ voice_name: sel.value, voice_lang: lang() }, { [vkeyName()]: sel.value }); V.sample(); m.querySelectorAll(".asvmiss").forEach(x => x.remove()); };
      const rt = m.querySelector("#asVRate"); if (rt) rt.onchange = () => { save({ voice_rate: +rt.value }, { assistant_voice_rate: +rt.value }); V.sample(); };
      m.querySelector("#asVLen").onchange = e => save({ answer_length: e.target.value }, { assistant_length: e.target.value });
      const tryB = m.querySelector("#asVTry"); if (tryB) tryB.onclick = () => V.sample();
      m.querySelector("#asVDone").onclick = () => { m.hidden = true; V.paint(); el("#asVoice")?.focus(); };
      if (fid) { const f = m.querySelector("#" + fid); if (f) f.focus(); }   // keep the keyboard / screen reader where it was
      V.paint();
    };
    // a picked natural voice is heard in its own language; otherwise the sample is in the assistant's language
    V.sample = id => { if (!V.canPlay() || !V.enabled()) return; V.replayIdx = -1; V.end();
      V.say(id ? I18N[/^e/.test(id) ? "es" : "en"].sampleText : tr("sampleText"), [], false); };
    V.save = save;
    // which engines this server offers (natural voices need the voice-service key in Render)
    V.loadVoices = () => api("/api/assistant/voices").then(r => { V.naturalOk = !!r.natural; V.kokoro = r.voices || []; V.menu(true); }).catch(() => {});
    V.ui = ui;
    return V;
  })();

  // ---------- proposed date changes: a card under the answer; nothing changes until Confirm ----------
  const fdate = d => { if (!d) return tr("noDate"); const x = new Date(d + "T12:00:00"); return x.toLocaleDateString(LANG[lang()].code, { weekday: "short", month: "short", day: "numeric", ...(x.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }); };
  const when = (d, t) => fdate(d) + (t ? " · " + t : "");
  function propHtml(ps) {
    if (!ps || !ps.length) return "";
    const pend = ps.filter(p => p.status === "pending");
    return `<div class="asprops">${ps.map(p => `<div class="asprop" data-st="${esc(p.status)}">
        <div class="aspk">${esc(tr("types")[p.type] || tr("item"))}${p.kind === "task" ? esc(tr("dueDate")) : ""}</div>
        <div class="aspt">${esc(p.title || "")}</div>
        <div class="aspd"><span class="aspold">${esc(when(p.old_date, p.old_time))}</span> <span aria-hidden="true">→</span><span class="sr-only" style="position:absolute;left:-9999px">${esc(tr("to"))}</span> <b>${esc(when(p.new_date, p.new_time))}</b></div>
        ${p.status === "pending" && p.type === "hearing" ? `<div class="aspw">${esc(tr("wHearing"))}</div>` : ""}
        ${p.status === "pending" && p.type === "deadline" ? `<div class="aspw">${esc(tr("wDeadline"))}</div>` : ""}
        ${p.status === "pending" && [0, 6].includes(new Date(p.new_date + "T12:00:00").getDay()) ? `<div class="aspw">${esc(tr("weekend")(new Date(p.new_date + "T12:00:00").getDay()))}</div>` : ""}
        ${p.status === "pending" ? `<div class="row asprow"><button type="button" class="btn sm" data-pconf="${+p.id}">${esc(tr("confirm"))}</button><button type="button" class="btn sm ghost" data-pcan="${+p.id}">${esc(tr("cancel"))}</button><span class="ashint">${esc(tr("orSay"))}</span></div>`
          : `<div class="asps">${esc(p.status === "applied" ? tr("pMoved") : p.status === "cancelled" ? tr("pCancelled") : tr("pExpired"))}</div>`}
      </div>`).join("")}${pend.length > 1 ? `<div class="row asprow"><button type="button" class="btn sm" data-pall="${pend.map(p => +p.id).join(",")}">${esc(tr("confirmAll")(pend.length))}</button></div>` : ""}</div>`;
  }
  const allProps = () => S.msgs.flatMap(m => m.proposals || []);
  const setProp = np => { for (const m of S.msgs) (m.proposals || []).forEach((p, i, a) => { if (+p.id === +np.id) a[i] = np; }); };
  // after a move, redraw the page underneath only when nothing is being typed there (a redraw would lose it)
  function refreshScreen() {
    try {
      const app = document.querySelector("#app"), a = document.activeElement;
      const busy = app && ((a && app.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) || (a && app.contains(a) && a.isContentEditable)
        || [...app.querySelectorAll("textarea, input[type=text], input:not([type])")].some(x => x.value !== x.defaultValue));
      if (busy) return toast(tr("movedLater"));
      if (assistCtx.case_id && window.caseHub && document.querySelector("#app .cdet")) caseHub(assistCtx.case_id);   // only when the case page is what's showing
      else if (["today", "calendar", "tasks", "dashboard"].includes(tab) && !(typeof subView !== "undefined" && subView) && typeof show === "function") show();
    } catch (e) {}
  }
  async function decide(ids, how) {
    let moved = 0, msg = "";
    for (const id of ids) {
      try { const r = await api(`/api/assistant/proposals/${id}/${how}`, { method: "POST" }); setProp(r.proposal); if (how === "confirm" && r.proposal.status === "applied") moved++; }
      catch (e) { if (e.data && e.data.proposal) setProp(e.data.proposal); msg = errText(e.message) || tr("failed"); }
    }
    draw();
    if (moved) { toast(tr("movedN")(moved)); refreshScreen(); }
    if (msg) toast(msg);
  }
  function wireProps(root) {
    root.querySelectorAll("[data-pconf]").forEach(b => b.onclick = () => { b.disabled = true; decide([+b.dataset.pconf], "confirm"); });
    root.querySelectorAll("[data-pcan]").forEach(b => b.onclick = () => { b.disabled = true; decide([+b.dataset.pcan], "cancel"); });
    root.querySelectorAll("[data-pall]").forEach(b => b.onclick = () => { b.closest(".asprops").querySelectorAll("button").forEach(x => x.disabled = true); decide(b.dataset.pall.split(",").map(Number), "confirm"); });
  }

  // ---------- the panel ----------
  function build() {
    panel = document.createElement("aside"); panel.id = "asPanel"; panel.className = "asp"; panel.hidden = true;
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", NAME);
    panel.innerHTML = `<div class="ash"><h2 id="asH"></h2>
        <button type="button" class="btn sm ghost aslb" id="asLang" aria-expanded="false" aria-controls="asLm">${GLOBE}<span id="asLangC"></span></button>
        ${VOICE.ok || VOICE.canSay ? `<button type="button" class="btn sm ghost asvt" id="asVoice" aria-expanded="false" aria-controls="asVm"></button>` : ""}
        <button type="button" class="btn sm ghost" id="asNew"></button>
        <button type="button" class="btn sm ghost" id="asHist"></button>
        <button type="button" class="iconb" id="asX">${ic("close", 20, 2)}</button></div>
      <div class="asvm" id="asLm" hidden></div>
      <div class="asvm" id="asVm" hidden role="group"></div>
      <div class="sr-only" id="asAnn" aria-live="polite" style="position:absolute;left:-9999px"></div>
      <div class="asctx" id="asCtx"></div>
      <div class="asbody" id="asBody"></div>
      <div class="asvs" id="asVs" hidden aria-live="polite"><span class="ddot" aria-hidden="true"></span><span id="asVsT"></span><button type="button" class="btn sm ghost" id="asVsEnd">End</button></div>
      <form class="asf" id="asF" data-nomic><label for="asIn" id="asInL" class="sr-only" style="position:absolute;left:-9999px"></label>
        <textarea id="asIn" rows="2" maxlength="4000"></textarea>
        ${VOICE.ok ? `<button type="button" class="asmic" id="asMic">${MIC}</button>` : ""}
        <button class="btn" id="asGo"></button></form>`;
    document.body.appendChild(panel);
    VOICE.loadVoices();
    panel.querySelector("#asX").onclick = () => setOpen(false);
    const mic = panel.querySelector("#asMic"); if (mic) mic.onclick = () => VOICE.tap();
    const vt = panel.querySelector("#asVoice"); if (vt) vt.onclick = () => { closeLangMenu(); VOICE.menu(); };
    panel.querySelector("#asLang").onclick = () => langMenu();
    panel.querySelector("#asVsEnd").onclick = () => VOICE.end();
    panel.querySelector("#asNew").onclick = () => { VOICE.end(); S.thread = null; S.threadCase = assistCtx.case_id; S.msgs = []; S.view = "chat"; draw(); panel.querySelector("#asIn").focus(); };
    panel.querySelector("#asHist").onclick = () => { VOICE.end(); S.view = S.view === "hist" ? "chat" : "hist"; draw(); };
    panel.querySelector("#asF").onsubmit = e => { e.preventDefault(); VOICE.end(); send(); };
    panel.querySelector("#asIn").addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && wide()) { e.preventDefault(); VOICE.end(); send(); } });
    panel.querySelector("#asH").setAttribute("tabindex", "-1");
    panel.addEventListener("keydown", e => { if (e.key !== "Tab" || wide()) return;   // phones: Tab wraps inside the sheet instead of reaching the page hidden behind it
      const f = [...panel.querySelectorAll("button,input,select,textarea,a[href],[tabindex]:not([tabindex='-1'])")].filter(x => !x.disabled && x.offsetParent !== null);
      if (!f.length) return; const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.querySelector("#asH"))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } });
    document.addEventListener("keydown", e => { if (e.key !== "Escape" || !S.open) return;
      const lm = panel.querySelector("#asLm"); if (lm && !lm.hidden && (lm.contains(document.activeElement) || document.activeElement === panel.querySelector("#asLang"))) { closeLangMenu(true); return; }
      const vm = panel.querySelector("#asVm"); if (vm && !vm.hidden && (vm.contains(document.activeElement) || document.activeElement === panel.querySelector("#asVoice"))) { vm.hidden = true; VOICE.paint(); panel.querySelector("#asVoice")?.focus(); return; }
      if (!wide()) setOpen(false); });
  }
  // the panel's own words, in the assistant's language (redrawn on every draw, so a change shows at once)
  function relabel() {
    const L1 = lang(), $p = id => panel.querySelector(id);
    panel.setAttribute("lang", L1); panel.setAttribute("aria-label", L1 === "es" ? "Asistente de Case Desk" : NAME);
    $p("#asH").innerHTML = `${tr("full") ? `<span class="asfull">${esc(tr("full"))}</span>` : ""}${esc(tr("title"))}`;
    $p("#asLangC").textContent = L1.toUpperCase(); const lb = $p("#asLang"); lb.setAttribute("aria-label", tr("langBtn")); lb.setAttribute("title", tr("langLegend"));
    $p("#asNew").textContent = tr("newBtn"); $p("#asNew").title = tr("newTip"); $p("#asHist").title = tr("histTip");
    $p("#asX").setAttribute("aria-label", tr("close")); $p("#asVm").setAttribute("aria-label", tr("options"));
    $p("#asInL").textContent = tr("ask"); $p("#asIn").placeholder = tr("placeholder"); $p("#asGo").textContent = tr("send"); $p("#asVsEnd").textContent = tr("end");
    const mic = $p("#asMic"); if (mic) { mic.title = tr("talkTip"); if (VOICE.state === "idle") mic.setAttribute("aria-label", tr("talk")); }
    const b = $("#asBtn"); if (b) { b.setAttribute("aria-label", L1 === "es" ? "Asistente de Case Desk" : NAME); const l = b.querySelector(".asl"); if (l) l.textContent = tr("title"); }
  }
  // the language list: each language in its own name, with the other language's word for it after (screen readers read each in its own language)
  const langOpts = () => Object.keys(LANG).map(k => `<option value="${k}" lang="${k}" ${lang() === k ? "selected" : ""}>${esc(LANG[k].name)}${k !== lang() ? ` (${esc(k === "es" ? "Spanish" : "inglés")})` : ""}</option>`).join("");
  function langMenu() {
    const m = panel.querySelector("#asLm"), b = panel.querySelector("#asLang");
    if (!m.hidden) return closeLangMenu();
    const vm = panel.querySelector("#asVm"); if (vm && !vm.hidden) { vm.hidden = true; VOICE.paint(); }
    m.innerHTML = `<fieldset class="aslf" aria-describedby="asLHint"><legend>${esc(tr("langLegend"))}</legend>
        ${Object.keys(LANG).map(k => `<label class="asvrow asl1" lang="${k}"><input type="radio" name="asLangR" value="${k}" ${lang() === k ? "checked" : ""}> <span><b>${esc(LANG[k].name)}</b>${k !== lang() ? ` <span class="ashint" lang="${lang()}">(${esc(k === "es" ? "Spanish" : "inglés")})</span>` : ""}</span></label>`).join("")}
      </fieldset><div class="ashint" id="asLHint">${esc(tr("langHint"))}</div>
      <div class="row" style="gap:8px"><button type="button" class="btn sm" id="asLDone">${esc(tr("done"))}</button></div>`;
    m.hidden = false; b.setAttribute("aria-expanded", "true");
    m.querySelectorAll("input[name=asLangR]").forEach(r => r.onchange = () => setLang(r.value, `input[name=asLangR][value=${r.value}]`));
    m.querySelector("#asLDone").onclick = () => closeLangMenu(true);
    (m.querySelector("input[name=asLangR]:checked") || m.querySelector("input")).focus();
  }
  // screen readers: say just this (the conversation area is not a live region, so a redraw doesn't re-read it)
  function announce(t) { const a = panel && panel.querySelector("#asAnn"); if (!a || !t) return; a.textContent = ""; setTimeout(() => { a.textContent = t; }, 50); }
  const plain = t => String(t || "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_#`>]/g, "").replace(/\s+/g, " ").trim();
  function closeLangMenu(focus) { const m = panel && panel.querySelector("#asLm"); if (!m || m.hidden) return; m.hidden = true; panel.querySelector("#asLang").setAttribute("aria-expanded", "false"); if (focus) panel.querySelector("#asLang").focus(); }
  async function setLang(k, refocus) {
    if (!LANG[k] || k === lang()) return;
    const was = lang();
    VOICE.end(); VOICE.reset();
    if (me) me.prefs = { ...(me.prefs || {}), assistant_language: k };   // the panel switches at once; the server must have it before the next question or the brief
    const saving = api("/api/assistant/prefs", { method: "PUT", body: { language: k } });
    const lm = panel.querySelector("#asLm"), vm = panel.querySelector("#asVm");
    if (lm && !lm.hidden) { lm.hidden = true; langMenu(); }          // redraw the open menu in the new language
    if (vm && !vm.hidden) VOICE.menu(true);
    draw();
    const f = refocus && panel.querySelector(refocus); if (f) f.focus();
    const a = panel.querySelector("#asAnn"); a.textContent = ""; setTimeout(() => { a.textContent = tr("langNow")(LANG[k].name); }, 50);
    try { await saving; }
    catch (e) {   // not saved (offline): go back, so the panel and the server agree
      if (me) me.prefs = { ...(me.prefs || {}), assistant_language: was }; VOICE.reset(); draw();
      const lm2 = panel.querySelector("#asLm"); if (lm2 && !lm2.hidden) { lm2.hidden = true; langMenu(); }
      const vm2 = panel.querySelector("#asVm"); if (vm2 && !vm2.hidden) VOICE.menu(true);
      toast(errText(e.message || "") || tr("failed")); return; }
    if (window.assistBriefRefresh) window.assistBriefRefresh();   // after the save, so the Today card shows the brief in the new language
  }
  function drawCtx() {
    const c = panel.querySelector("#asCtx"), x = ctxNow();
    c.innerHTML = x.case_id ? `${esc(tr("lookingAt"))} <b>${esc(assistCtx.case_label || tr("thisCase"))}</b>` : `${esc(tr("screen"))} <b>${esc(x.screen || "")}</b>`;
  }
  function draw() {
    if (!panel) return; relabel(); drawCtx(); VOICE.paint();
    const body = panel.querySelector("#asBody");
    panel.querySelector("#asF").hidden = S.view !== "chat";
    panel.querySelector("#asHist").textContent = S.view === "hist" ? tr("back") : tr("hist");
    if (S.view === "hist") return drawHist(body);
    body.innerHTML = (S.msgs.length ? "" : `<div class="ashint">${esc(assistCtx.case_id ? tr("emptyCase") : tr("empty"))}${VOICE.ok && VOICE.enabled() ? esc(tr("emptyMic")) : ""}</div>`)
      + S.msgs.map((m, i) => m.role === "user" ? `<div class="asm asu">${esc(m.text)}</div>` : m.role === "error" ? `<div class="asm ase">${m.html}</div>` : `<div class="asm asa">${VOICE.canPlay() && VOICE.enabled() ? (VOICE.replaying && VOICE.replayIdx === i ? `<button type="button" class="assay on" data-asay="${i}" aria-label="${esc(tr("stopRead"))}" title="${esc(tr("stopRead"))}">${STOP}</button>` : `<button type="button" class="assay" data-asay="${i}" aria-label="${esc(tr("readOut"))}" title="${esc(tr("readOutTip"))}">${SPK}</button>`) : ""}${render(m.text, m.links)}${propHtml(m.proposals)}</div>`).join("")
      + (S.busy ? `<div class="asm asa busy ashint">${esc(tr("sThink"))}</div>` : "");
    wireLinks(body); wireProps(body);
    body.querySelectorAll("[data-asay]").forEach(b => b.onclick = () => { if (VOICE.replaying && +b.dataset.asay === VOICE.replayIdx) return VOICE.hushReplay();
      const m = S.msgs[+b.dataset.asay]; if (m) { VOICE.replayIdx = +b.dataset.asay; VOICE.say(m.text, m.links, false); } });
    body.scrollTop = body.scrollHeight;
  }
  async function drawHist(body) {
    body.innerHTML = `<div class="ashint">${esc(tr("loading"))}</div>`;
    let r; try { r = await api("/api/assistant/threads"); } catch (e) { body.innerHTML = `<div class="asm ase">${errHtml(e)}</div>`; return; }
    body.innerHTML = `<div class="ashint">${esc(tr("histHint"))}</div>`
      + (r.threads.map(t => `<div class="asth"><button type="button" class="lk" data-th="${t.id}"><b>${esc(t.title || tr("conv"))}</b><br><span class="ashint">${esc(t.style ? String(t.style).slice(0, 60) + " · " : "")}${esc(new Date(t.updated_at).toLocaleString(LANG[lang()].code, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))}</span></button>
        <button type="button" class="btn sm ghost" data-thdel="${t.id}" aria-label="${esc(tr("delAria"))}">${esc(tr("del"))}</button></div>`).join("") || `<div class="ashint">${esc(tr("noConv"))}</div>`)
      + (r.threads.length ? `<div class="row" style="margin-top:8px"><button type="button" class="btn sm danger" id="asDelAll">${esc(tr("delAll"))}</button></div>` : "");
    body.querySelectorAll("[data-th]").forEach(b => b.onclick = () => loadThread(+b.dataset.th));
    body.querySelectorAll("[data-thdel]").forEach(b => b.onclick = async () => { if (!b.dataset.sure) { b.dataset.sure = 1; b.textContent = tr("tapAgain"); b.setAttribute("aria-label", `${tr("delAria")}: ${tr("tapAgain")}`); announce(tr("tapAgain")); return; }
      await api(`/api/assistant/threads/${b.dataset.thdel}`, { method: "DELETE" }).catch(() => {}); if (S.thread === +b.dataset.thdel) { S.thread = null; S.msgs = []; } drawHist(body); });
    const all = body.querySelector("#asDelAll"); if (all) all.onclick = async () => { if (!all.dataset.sure) { all.dataset.sure = 1; all.textContent = tr("delAllAgain"); announce(tr("delAllAgain")); return; }
      await api("/api/assistant/threads", { method: "DELETE" }).catch(() => {}); S.thread = null; S.msgs = []; drawHist(body); };
  }
  async function loadThread(id) {
    try { const r = await api(`/api/assistant/threads/${id}`); S.thread = r.thread.id; S.threadCase = r.thread.case_id; S.msgs = r.messages.map(m => ({ role: m.role, text: m.text, links: m.links, proposals: m.proposals || [] })); }
    catch (e) { S.thread = null; S.msgs = [{ role: "error", html: errHtml(e) }]; }
    S.view = "chat"; draw();
  }
  // the page changed: a different case starts (or reopens) that case's conversation
  async function follow() {
    if (!S.open || !panel) return;
    const cid = assistCtx.case_id || null;
    if (cid && cid !== S.threadCase) {
      S.thread = null; S.threadCase = cid; S.msgs = [];
      try { const r = await api(`/api/assistant/threads?case_id=${cid}`); if (r.threads[0] && assistCtx.case_id === cid) return loadThread(r.threads[0].id); } catch (e) {}
    }
    draw();
  }
  window.assistFollow = () => { if (S.open) follow(); };
  window.assistOpen = () => { if (!me || me.dev_view) return; if (S.open) follow(); else setOpen(true); };
  async function send(voice) {
    const inp = panel.querySelector("#asIn"), text = inp.value.trim();
    if (!text || S.busy) return;
    let said = null; const conv = S.msgs;
    S.busy = true; S.msgs.push({ role: "user", text }); inp.value = ""; draw();
    try {
      const r = await api("/api/assistant/chat", { method: "POST", body: { message: text, thread_id: S.thread, context: { ...ctxNow(), voice: !!voice, length: VOICE.length() } } });
      if (S.msgs !== conv) { S.busy = false; draw(); return; }   // they started another conversation while waiting; this answer stays saved in its own
      S.thread = r.thread_id; if (S.threadCase == null) S.threadCase = assistCtx.case_id || null;
      S.msgs.push({ role: "assistant", text: r.reply, links: r.links, proposals: r.proposals || [] }); if (voice) said = r; else announce(plain(r.reply));
      if (r.updated && r.updated.length) { r.updated.forEach(setProp); if (r.updated.some(u => u.status === "applied")) setTimeout(refreshScreen, 0); }   // they said "confirm" / "no"
    } catch (e) { if (S.msgs !== conv) { S.busy = false; draw(); return; } S.msgs.push({ role: "error", html: errHtml(e) }); announce(errText(e.message || "") || tr("failed")); if (!inp.value) inp.value = text; if (voice) VOICE.end(tr("noAnswerVoice")); }
    S.busy = false; draw();
    // a change waiting: read the answer and keep listening; saying "confirm" (or "no") decides it (Steve, Nov 13)
    if (said && VOICE.on) VOICE.say(said.reply, said.links, true);
  }
  function setOpen(on, quiet) {
    if (!panel) build();
    if (!on) { VOICE.end(); const vm = panel.querySelector("#asVm"); if (vm) vm.hidden = true; VOICE.paint(); }
    S.open = !!on; panel.hidden = !on; document.body.classList.toggle("ason", !!on);
    const b = $("#asBtn"); if (b) b.setAttribute("aria-expanded", String(!!on));
    if (!on) closeLangMenu();
    if (wide()) panel.removeAttribute("aria-modal"); else panel.setAttribute("aria-modal", "true");
    if (on) { S.view = "chat"; follow(); setTimeout(() => { if (!S.open || panel.contains(document.activeElement)) return; if (wide()) panel.querySelector("#asIn").focus({ preventScroll: true }); else panel.querySelector("#asH").focus({ preventScroll: true }); }, 50); }
    else if (!wide() && panel.contains(document.activeElement)) { const b2 = $("#asBtn"); if (b2) b2.focus(); }
    if (!quiet && me && !me.dev_view) { me.prefs = { ...(me.prefs || {}), assistant_open: !!on }; api("/api/assistant/prefs", { method: "PUT", body: { open: !!on } }).catch(() => {}); }
  }
  // called by app.js when the signed-in shell shows (off = signed out)
  window.assistShell = off => {
    const b = $("#asBtn"); if (!b) return;
    if (off || !me || me.dev_view) { VOICE.end(); b.hidden = true; if (panel) { panel.hidden = true; document.body.classList.remove("ason"); } S.open = false; S.thread = null; S.msgs = []; return; }
    b.hidden = false;
    b.onclick = () => setOpen(!S.open);
    if (lang() === "es") { b.setAttribute("aria-label", "Asistente de Case Desk"); const l = b.querySelector(".asl"); if (l) l.textContent = tr("title"); }
    // remembered per person: the side panel reopens on desktop (a phone always starts on the page, not a full-screen sheet)
    if (!S.restored) { S.restored = true; if (me.prefs && me.prefs.assistant_open && wide()) setOpen(true, true); }
  };
  addEventListener("tcd:screen", () => { if (S.open && panel) follow(); });

  // ---------- the daily brief (Today) ----------
  window.assistBrief = async el => {
    if (!el || !me || me.dev_view) { if (el) el.remove(); return; }
    window.assistBriefRefresh = () => { if (el.isConnected) window.assistBrief(el); };
    el.setAttribute("lang", lang());
    const head = `<div class="bh"><h2 id="tdBriefH">${esc(tr("brief"))}</h2><button type="button" class="btn sm ghost" id="brGo">${esc(tr("genBrief"))}</button></div>`;
    el.innerHTML = head + `<div class="brief mute">${esc(tr("loading"))}</div>`;
    let r; try { r = await api("/api/assistant/brief"); } catch (e) { el.innerHTML = head + `<div class="brief">${errHtml(e)}</div>`; wireLinks(el); return; }
    const show = b => {
      el.innerHTML = head + (b ? `<div class="brief">${render(b.text, b.links)}<div class="mute" style="font-size:12px;margin-top:6px">${esc(tr("briefWritten")(new Date(b.created_at).toLocaleTimeString(LANG[lang()].code, { hour: "numeric", minute: "2-digit" })))}</div></div>`
        : `<div class="brief mute">${esc(r.available ? tr("briefIntro") : (me.demo ? tr("demoOff") : tr("addKey")))}</div>`);
      const g = el.querySelector("#brGo"); g.textContent = b ? tr("refresh") : tr("genBrief"); g.disabled = !r.available;
      g.onclick = async () => { g.disabled = true; g.textContent = tr("writing");
        try { const x = await api("/api/assistant/brief", { method: "POST", body: { refresh: !!b } }); r.available = true; show(x.brief); }
        catch (e) { show(b); const d = document.createElement("div"); d.className = "brief"; d.innerHTML = errHtml(e); el.appendChild(d); wireLinks(el); } };
      wireLinks(el);
    };
    show(r.brief);
  };
})();

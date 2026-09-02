(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $("canvas"),
    ctx = canvas.getContext("2d"),
    workspace = $("workspace");
  const state = {
    socket: null,
    room: "",
    name: "",
    clientId: "",
    nodeId: "",
    tool: "select",
    objects: new Map(),
    participants: [],
    view: { x: 0, y: 0, scale: 1 },
    draft: null,
    selected: null,
    drag: null,
    seen: new Set(),
    undo: [],
    redo: [],
    reconnect: null,
    cursorTimer: null,
    clipboard: null,
    grid: false,
    openMenu: null,
    editor: null,
    requestedMode: "whiteboard",
    selectedCreateMode: "whiteboard",
    flow: "landing",
    connectionAction: "join",
    joinFailure: false,
    mode: "whiteboard",
    game: null,
    gamePrivate: {},
    guessCooldownUntil: 0,
  };
  const colours = [
    "#635bff",
    "#0ea5e9",
    "#10b981",
    "#f97316",
    "#ec4899",
    "#8b5cf6",
  ];
  let awaitingWelcome = true;
  const preWelcomeOperations = [];
  const id = (prefix) => `${prefix}-${crypto.randomUUID().replaceAll("-", "")}`;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const roomPattern = /^[A-Z0-9][A-Z0-9-]{1,23}$/;
  // The chosen room flows from this normalized value into state, URL and WebSocket.
  function normalizeRoom(value) {
    return value
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .slice(0, 24);
  }
  const style = () => ({
    stroke: $("strokeColor").value,
    fill: $("fillColor").value,
    width: +$("widthInput").value,
  });
  const toolLabels = { select: "Select", pen: "Pen", highlighter: "Highlighter", eraser: "Eraser", line: "Line", arrow: "Arrow", double_arrow: "Double arrow", connector: "Connector", rectangle: "Rectangle", ellipse: "Ellipse", triangle: "Triangle", diamond: "Diamond", text: "Text", sticky: "Sticky note" };
  const toolGroups = { lines: ["line", "arrow", "double_arrow", "connector"], shapes: ["rectangle", "ellipse", "triangle", "diamond"] };
  const world = (event) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - r.left - state.view.x) / state.view.scale,
      y: (event.clientY - r.top - state.view.y) / state.view.scale,
    };
  };
  const screen = (point) => ({
    x: point.x * state.view.scale + state.view.x,
    y: point.y * state.view.scale + state.view.y,
  });
  const normalise = (x, y, w, h) => ({
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  });

  function resize() {
    const r = workspace.getBoundingClientRect();
    canvas.width = r.width * devicePixelRatio;
    canvas.height = r.height * devicePixelRatio;
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    positionEditor();
    render();
  }
  function render() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.save();
    ctx.translate(state.view.x, state.view.y);
    ctx.scale(state.view.scale, state.view.scale);
    orderedObjects().forEach(drawObject);
    if (state.draft) drawObject(state.draft);
    if (state.selected && state.objects.has(state.selected))
      drawSelection(state.objects.get(state.selected));
    ctx.restore();
    $("zoomValue").textContent = `${Math.round(state.view.scale * 100)}%`;
    $("emptyHint").classList.toggle("hidden", state.objects.size > 0);
    positionObjectToolbar();
    renderProperties();
  }
  const orderedObjects = () => [...state.objects.values()].sort((a, b) => (a.z || 0) - (b.z || 0) || (a.updatedAt || 0) - (b.updatedAt || 0));
  function drawObject(o) {
    const s = o.style || {};
    ctx.save();
    ctx.strokeStyle = s.stroke || "#635bff";
    ctx.fillStyle = s.fill || "#ffffff";
    ctx.lineWidth = s.width || 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (o.type === "pen" || o.type === "highlighter") {
      if (o.type === "highlighter") ctx.globalAlpha = s.opacity ?? .28;
      const p = o.points || [];
      if (p.length) {
        ctx.beginPath();
        ctx.moveTo(p[0].x, p[0].y);
        p.slice(1).forEach((v) => ctx.lineTo(v.x, v.y));
        if (p.length === 1) ctx.lineTo(p[0].x + 0.1, p[0].y + 0.1);
        ctx.stroke();
      }
    } else if (["line", "arrow", "double_arrow", "connector"].includes(o.type)) {
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(o.x + o.w, o.y + o.h);
      ctx.stroke();
      if (o.type === "arrow" || o.type === "double_arrow") {
        const angle = Math.atan2(o.h, o.w);
        const endX = o.x + o.w,
          endY = o.y + o.h;
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - 11 * Math.cos(angle - Math.PI / 6),
          endY - 11 * Math.sin(angle - Math.PI / 6),
        );
        ctx.moveTo(endX, endY);
        ctx.lineTo(
          endX - 11 * Math.cos(angle + Math.PI / 6),
          endY - 11 * Math.sin(angle + Math.PI / 6),
        );
        ctx.stroke();
        if (o.type === "double_arrow") {
          ctx.beginPath();
          ctx.moveTo(o.x, o.y);
          ctx.lineTo(o.x + 11 * Math.cos(angle - Math.PI / 6), o.y + 11 * Math.sin(angle - Math.PI / 6));
          ctx.moveTo(o.x, o.y);
          ctx.lineTo(o.x + 11 * Math.cos(angle + Math.PI / 6), o.y + 11 * Math.sin(angle + Math.PI / 6));
          ctx.stroke();
        }
      }
    } else if (o.type === "rectangle") {
      ctx.beginPath();
      ctx.rect(o.x, o.y, o.w, o.h);
      if (s.fill && s.fill !== "#ffffff") ctx.fill();
      ctx.stroke();
    } else if (o.type === "ellipse") {
      ctx.beginPath();
      ctx.ellipse(
        o.x + o.w / 2,
        o.y + o.h / 2,
        Math.abs(o.w / 2),
        Math.abs(o.h / 2),
        0,
        0,
        Math.PI * 2,
      );
      if (s.fill && s.fill !== "#ffffff") ctx.fill();
      ctx.stroke();
    } else if (o.type === "triangle" || o.type === "diamond") {
      ctx.beginPath();
      if (o.type === "triangle") {
        ctx.moveTo(o.x + o.w / 2, o.y); ctx.lineTo(o.x + o.w, o.y + o.h); ctx.lineTo(o.x, o.y + o.h);
      } else {
        ctx.moveTo(o.x + o.w / 2, o.y); ctx.lineTo(o.x + o.w, o.y + o.h / 2); ctx.lineTo(o.x + o.w / 2, o.y + o.h); ctx.lineTo(o.x, o.y + o.h / 2);
      }
      ctx.closePath();
      if (s.fill && s.fill !== "#ffffff") ctx.fill();
      ctx.stroke();
    } else if (o.type === "text") {
      ctx.fillStyle = s.stroke || "#182338";
      ctx.font = `${Math.max(14, s.width * 5)}px Inter, sans-serif`;
      ctx.textBaseline = "top";
      (o.text || "Text")
        .split("\n")
        .forEach((line, i) => ctx.fillText(line, o.x, o.y + i * (s.width * 6)));
    } else if (o.type === "sticky") {
      ctx.fillStyle = s.fill || "#fef3c7";
      ctx.strokeStyle = "#eab308";
      ctx.lineWidth = 1;
      ctx.shadowColor = "#33415525";
      ctx.shadowBlur = 8;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.strokeRect(o.x, o.y, o.w, o.h);
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#4a3d17";
      ctx.font = "14px Inter, sans-serif";
      ctx.textBaseline = "top";
      wrapText(o.text || "New note", o.x + 10, o.y + 11, o.w - 20, 19);
    }
    ctx.restore();
  }
  function wrapText(text, x, y, max, line) {
    let words = text.split(/\s+/),
      current = "",
      offset = 0;
    for (const word of words) {
      const test = `${current} ${word}`.trim();
      if (ctx.measureText(test).width > max && current) {
        ctx.fillText(current, x, y + offset);
        offset += line;
        current = word;
      } else current = test;
    }
    if (current) ctx.fillText(current, x, y + offset);
  }
  function bounds(o) {
    if (o.type === "pen" || o.type === "highlighter") {
      const pts = o.points || [];
      if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
      const xs = pts.map((p) => p.x),
        ys = pts.map((p) => p.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs),
        h: Math.max(...ys) - Math.min(...ys),
      };
    }
    if (["line", "arrow", "double_arrow", "connector"].includes(o.type))
      return normalise(o.x, o.y, o.w, o.h);
    return { x: o.x, y: o.y, w: o.w, h: o.h };
  }
  function drawSelection(o) {
    const b = bounds(o);
    ctx.save();
    ctx.strokeStyle = "#635bff";
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = 1 / state.view.scale;
    ctx.strokeRect(
      b.x - 5 / state.view.scale,
      b.y - 5 / state.view.scale,
      b.w + 10 / state.view.scale,
      b.h + 10 / state.view.scale,
    );
    if (!["pen", "highlighter", "line", "arrow", "double_arrow", "connector"].includes(o.type)) {
      ctx.fillStyle = "#fff"; ctx.setLineDash([]); ctx.lineWidth = 1 / state.view.scale;
      [[b.x,b.y],[b.x+b.w,b.y],[b.x,b.y+b.h],[b.x+b.w,b.y+b.h]].forEach(([x,y]) => {
        const d = 7 / state.view.scale; ctx.fillRect(x-d/2,y-d/2,d,d); ctx.strokeRect(x-d/2,y-d/2,d,d);
      });
    }
    ctx.restore();
  }
  function resizeHandle(point, object) {
    if (["pen", "highlighter", "line", "arrow", "double_arrow", "connector"].includes(object.type)) return null;
    const b = bounds(object), threshold = 10 / state.view.scale;
    return [["nw",b.x,b.y],["ne",b.x+b.w,b.y],["sw",b.x,b.y+b.h],["se",b.x+b.w,b.y+b.h]]
      .find(([,x,y]) => Math.hypot(point.x-x,point.y-y) <= threshold)?.[0] || null;
  }
  function hit(point) {
    for (const o of orderedObjects().reverse()) {
      const b = bounds(o),
        pad = 8 / state.view.scale;
      if (
        point.x >= b.x - pad &&
        point.x <= b.x + b.w + pad &&
        point.y >= b.y - pad &&
        point.y <= b.y + b.h + pad
      )
        return o;
    }
    return null;
  }
  function setTool(tool) {
    if (state.mode === "game" && !["pen", "eraser"].includes(tool)) return;
    state.tool = tool;
    state.selected = null;
    closeToolMenu();
    document
      .querySelectorAll(".tool")
      .forEach((b) => b.classList.toggle("active", Boolean(b.dataset.tool === tool || (b.dataset.menu && toolGroups[b.dataset.menu].includes(tool)))));
    canvas.style.cursor =
      tool === "select" ? "default" : tool === "eraser" ? "cell" : tool === "pan" ? "grab" : "crosshair";
    render();
  }
  function closeToolMenu() { state.openMenu = null; $("toolMenu").hidden = true; }
  function openToolMenu(group, trigger) {
    if (state.openMenu === group) return closeToolMenu();
    const menu = $("toolMenu"), rect = trigger.getBoundingClientRect(), root = workspace.getBoundingClientRect();
    menu.innerHTML = toolGroups[group].map((tool) => `<button data-menu-tool="${tool}" class="${state.tool === tool ? "active" : ""}">${toolLabels[tool]}</button>`).join("");
    menu.style.top = `${Math.max(10, rect.top - root.top - 5)}px`;
    menu.hidden = false; state.openMenu = group;
    menu.querySelectorAll("[data-menu-tool]").forEach((button) => button.onclick = () => setTool(button.dataset.menuTool));
  }
  function renderProperties() {
    const selected = state.selected && state.objects.get(state.selected);
    const type = selected?.type || state.tool;
    const visible = !["select", "eraser"].includes(type);
    const properties = $("properties"); properties.hidden = !visible;
    if (!visible) return;
    const objectStyle = selected?.style || style();
    $("propertyLabel").textContent = selected ? `Selected ${toolLabels[type] || "object"}` : toolLabels[type] || "Properties";
    const fillVisible = ["rectangle", "ellipse", "triangle", "diamond", "sticky"].includes(type);
    const widthVisible = !["sticky"].includes(type);
    $("fillProperty").hidden = !fillVisible;
    $("widthProperty").hidden = !widthVisible;
    $("widthDivider").hidden = !widthVisible;
    $("strokeProperty").hidden = type === "sticky";
    if (objectStyle.stroke) $("strokeColor").value = objectStyle.stroke;
    if (objectStyle.fill) $("fillColor").value = objectStyle.fill;
    if (objectStyle.width) { $("widthInput").value = objectStyle.width; $("widthOutput").textContent = objectStyle.width; }
    document.querySelectorAll(".swatches [data-color]").forEach((button) => button.classList.toggle("active", button.dataset.color.toLowerCase() === $("strokeColor").value.toLowerCase()));
    document.querySelectorAll(".size-dots [data-width]").forEach((button) => button.classList.toggle("active", +button.dataset.width === +$("widthInput").value));
  }
  function changeStyle(key, value) {
    const selected = state.selected && state.objects.get(state.selected);
    if (selected) {
      if (selected.userId !== state.clientId) { toast("Only the object owner can change its style."); return; }
      const previous = clone(selected), object = { ...selected, style: { ...selected.style, [key]: value } };
      update(object, previous); return;
    }
    $(key === "stroke" ? "strokeColor" : key === "fill" ? "fillColor" : "widthInput").value = value;
    $("widthOutput").textContent = $("widthInput").value;
    renderProperties();
  }
  function nextZ(direction = "front") {
    const values = orderedObjects().map((o) => o.z || 0);
    return direction === "back" ? (Math.min(0, ...values) - 1) : (Math.max(0, ...values) + 1);
  }
  function positionObjectToolbar() {
    const bar = $("objectToolbar"), object = state.selected && state.objects.get(state.selected);
    if (!object || state.mode === "game") { bar.hidden = true; return; }
    const b = bounds(object), at = screen({ x: b.x + b.w / 2, y: b.y - 18 / state.view.scale });
    bar.hidden = false;
    bar.style.left = `${Math.max(8, Math.min(at.x, workspace.clientWidth - bar.offsetWidth - 8))}px`;
    bar.style.top = `${Math.max(8, at.y - 42)}px`;
  }
  function duplicate(object = state.objects.get(state.selected)) {
    if (!object) return;
    const copy = clone(object);
    copy.id = id("obj"); copy.userId = state.clientId; copy.x = (copy.x || 0) + 20; copy.y = (copy.y || 0) + 20; copy.z = nextZ();
    if (copy.points) copy.points = copy.points.map((p) => ({ x: p.x + 20, y: p.y + 20 }));
    create(copy); state.selected = copy.id; render();
  }
  function reorderSelected(action) {
    const object = state.objects.get(state.selected); if (!object) return;
    const list = orderedObjects(), index = list.findIndex((o) => o.id === object.id);
    let z = object.z || 0;
    if (action === "front") z = nextZ();
    else if (action === "back") z = nextZ("back");
    else if (action === "forward" && index < list.length - 1) z = (list[index + 1].z || 0) + .5;
    else if (action === "backward" && index > 0) z = (list[index - 1].z || 0) - .5;
    else return;
    update({ ...object, z }, object);
  }
  function apply(event) {
    if (state.seen.has(event.operationId)) return;
    state.seen.add(event.operationId);
    if (state.seen.size > 5000)
      state.seen = new Set([...state.seen].slice(-3000));
    const p = event.payload || {};
    if (
      event.eventType === "object:create" ||
      event.eventType === "object:update"
    )
      state.objects.set(p.object.id, p.object);
    if (event.eventType === "object:delete") {
      state.objects.delete(p.id);
      if (state.selected === p.id) state.selected = null;
    }
    if (event.eventType === "board:clear") state.objects.clear();
    if (event.eventType === "board:replace") {
      state.objects = new Map((p.objects || []).map((o) => [o.id, o]));
      state.selected = null;
    }
    render();
  }
  function operation(eventType, payload, history = true) {
    if (state.mode === "game" && !canDraw()) {
      toast("Only the current drawer can edit this game canvas.");
      return;
    }
    if (state.socket?.readyState !== WebSocket.OPEN) {
      toast("Reconnect before editing the board.");
      return;
    }
    const op = { type: "operation", operationId: id("op"), eventType, payload };
    if (history && eventType.startsWith("object:")) {
      state.undo.push({ eventType, payload: clone(payload) });
      state.redo = [];
    }
    apply(op);
    state.socket.send(JSON.stringify(op));
  }
  function canDraw() {
    return state.mode !== "game" || (state.game?.status === "drawing" && state.game?.drawerId === state.clientId);
  }
  function create(object) {
    if (!Number.isFinite(object.z)) object.z = nextZ();
    operation("object:create", { object });
  }
  function update(object, previous) {
    operation("object:update", { object });
    if (previous) state.undo[state.undo.length - 1].previous = previous;
  }
  function deleteObject(object, history = true) {
    operation("object:delete", { id: object.id }, history);
    if (history) state.undo[state.undo.length - 1].deleted = clone(object);
  }
  function undo() {
    const action = state.undo.pop();
    if (!action) {
      toast("Nothing to undo.");
      return;
    }
    state.redo.push(clone(action));
    if (action.eventType === "object:create")
      deleteObject(action.payload.object, false);
    else if (action.eventType === "object:delete")
      createFromHistory(action.deleted);
    else if (action.eventType === "object:update" && action.previous)
      operation("object:update", { object: action.previous }, false);
  }
  function createFromHistory(object) {
    operation("object:create", { object }, false);
  }
  function redo() {
    const action = state.redo.pop();
    if (!action) {
      toast("Nothing to redo.");
      return;
    }
    state.undo.push(clone(action));
    if (action.eventType === "object:create")
      createFromHistory(action.payload.object);
    else if (action.eventType === "object:delete")
      deleteObject(action.deleted, false);
    else if (action.eventType === "object:update")
      operation("object:update", action.payload, false);
  }
  function connect() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    awaitingWelcome = true;
    state.joinFailure = false;
    setConnection("connecting", "Connecting");
    const params = new URLSearchParams({
      name: state.name,
      client_id: state.clientId,
      action: state.connectionAction,
    });
    // Mode is a creation choice only. Join and reconnect never send one.
    if (state.connectionAction === "create") params.set("mode", state.requestedMode);
    state.socket = new WebSocket(`${scheme}://${location.host}/ws/${encodeURIComponent(state.room)}?${params}`);
    state.socket.onopen = () => setConnection("connected", "Connected");
    state.socket.onerror = () => state.socket.close();
    state.socket.onclose = () => {
      if (state.joinFailure) return;
      setConnection("disconnected", "Reconnecting");
      clearTimeout(state.reconnect);
      state.reconnect = setTimeout(connect, 1500);
    };
    state.socket.onmessage = (e) => handle(JSON.parse(e.data));
  }
  function handle(msg) {
    if (msg.type === "welcome") {
      state.clientId = msg.clientId;
      state.nodeId = msg.nodeId;
      state.mode = msg.mode || "whiteboard";
      state.connectionAction = "join";
      state.objects = new Map((msg.objects || []).map((o) => [o.id, o]));
      state.participants = msg.participants || [];
      awaitingWelcome = false;
      while (preWelcomeOperations.length) apply(preWelcomeOperations.shift());
      renderParticipants();
      applyRoomMode();
      render();
      toast(`Connected through ${msg.nodeId}.`);
      return;
    }
    if (msg.type === "room:error") {
      state.joinFailure = true;
      clearTimeout(state.reconnect);
      state.socket?.close();
      $("boardApp").hidden = true;
      $("joinScreen").hidden = false;
      showFlow(state.flow === "create" ? "create" : "join");
      $("joinError").textContent = msg.message || "Unable to enter this room.";
      setConnection("disconnected", "Disconnected");
      return;
    }
    if (msg.type === "game:state") {
      state.game = msg.state;
      state.gamePrivate = {};
      renderGame();
      return;
    }
    if (msg.type === "game:private") {
      state.gamePrivate = msg;
      renderGame();
      return;
    }
    if (msg.type === "operation") {
      if (awaitingWelcome) preWelcomeOperations.push(msg);
      else apply(msg);
      return;
    }
    if (msg.type === "cursor" && msg.clientId !== state.clientId)
      remoteCursor(msg);
    if (msg.type === "presence") {
      state.participants = msg.participants || [];
      renderParticipants();
      if (state.mode === "game") renderGame();
      if (msg.participant?.id !== state.clientId)
        toast(
          `${msg.participant.name} ${msg.action === "joined" ? "joined" : "left"} the room.`,
        );
    }
  }
  function setConnection(kind, label) {
    const el = $("connection");
    el.className = `connection ${kind}`;
    el.querySelector("span").textContent = label;
  }
  function renderParticipants() {
    const root = $("avatars");
    root.innerHTML = "";
    root.dataset.count = state.participants.length;
    state.participants.slice(0, 5).forEach((p) => {
      const e = document.createElement("span");
      e.className = "avatar";
      e.style.background = p.color || colours[0];
      e.textContent = p.name.slice(0, 2).toUpperCase();
      e.title = p.name;
      root.append(e);
    });
    root.title = `${state.participants.length} participant${state.participants.length === 1 ? "" : "s"} online`;
  }
  function sendGame(type, payload = {}) {
    if (state.socket?.readyState === WebSocket.OPEN)
      state.socket.send(JSON.stringify({ type, payload }));
  }
  function applyRoomMode() {
    const game = state.mode === "game";
    $("boardApp").classList.toggle("game-mode", game);
    $("gamePanel").hidden = !game;
    $("gameHeader").hidden = !game;
    if (game) setTool("pen");
  }
  function renderGame() {
    const game = state.game;
    if (!game) return;
    const meDrawer = game.drawerId === state.clientId;
    const drawer = game.players?.find((p) => p.id === game.drawerId);
    // Before Start, the authoritative player list is live room presence.  The
    // game state intentionally only has the creator until the host starts it.
    const roster = game.status === "lobby" ? state.participants : (game.players?.length ? game.players : state.participants);
    $("gamePhase").textContent = game.status.replace("_", " ");
    $("gameSettings").hidden = game.status !== "lobby" || game.hostId !== state.clientId;
    $("startGameBtn").disabled = roster.length < 2;
    $("roundsInput").value = String(game.rounds || 2);
    $("durationInput").value = String(game.duration || 60);
    if (game.status === "lobby")
      $("gameMessage").textContent = game.hostId === state.clientId ? "You are the host. Invite at least one player, then start." : "Waiting for the host to start the game.";
    else if (game.status === "word_selection")
      $("gameMessage").textContent = meDrawer ? "Choose a secret word. Your choices are private." : `${drawer?.name || "A player"} is choosing a word…`;
    else if (game.status === "drawing")
      $("gameMessage").textContent = meDrawer ? "You are drawing. Do not type the word." : `${drawer?.name || "A player"} is drawing…`;
    else if (game.status === "round_results") $("gameMessage").textContent = "Round over. Next turn is loading…";
    else if (game.status === "game_results") $("gameMessage").textContent = "Game complete — final rankings are shown below.";
    const word = state.gamePrivate.word || game.wordHint || "_ _ _";
    $("gameWord").textContent = game.status === "lobby" ? "Draw & Guess" : word;
    const choices = $("wordChoices");
    choices.innerHTML = "";
    if (meDrawer && game.status === "word_selection") {
      (state.gamePrivate.choices || []).forEach((choice) => {
        const button = document.createElement("button");
        button.textContent = choice.toUpperCase();
        button.onclick = () => sendGame("game:word", { word: choice });
        choices.append(button);
      });
    }
    $("gameClearBtn").hidden = !(meDrawer && game.status === "drawing");
    const players = $("gamePlayers");
    players.innerHTML = "";
    roster.slice().sort((a, b) => (game.scores?.[b.id] || 0) - (game.scores?.[a.id] || 0)).forEach((p) => {
      const row = document.createElement("div"); row.className = "game-player";
      row.innerHTML = `<span class="mini-avatar" style="background:${p.color || colours[0]}">${p.name.slice(0,2).toUpperCase()}</span><span>${p.name}${p.id === game.drawerId ? " ✎" : ""}${game.guessedIds?.includes(p.id) ? " ✓" : ""}</span><b>${game.scores?.[p.id] || 0}</b>`;
      players.append(row);
    });
    const chat = $("guessChat"); chat.innerHTML = "";
    (game.chat || []).forEach((entry) => { const line = document.createElement("div"); line.className = entry.system ? "system" : ""; line.textContent = entry.system ? entry.text : `${entry.name}: ${entry.text}`; chat.append(line); });
    chat.scrollTop = chat.scrollHeight;
    const results = $("gameResults"); results.hidden = !["round_results", "game_results"].includes(game.status);
    $("playAgainBtn").hidden = game.status !== "game_results" || game.hostId !== state.clientId;
    $("gameResultList").innerHTML = (game.results || []).map((r) => { const p = game.players?.find((x) => x.id === r.id); return `<div>${p?.name || "Player"} <b>+${r.points}</b></div>`; }).join("");
    const spectator = Boolean(game.turnOrder) && !(game.players || []).some((p) => p.id === state.clientId);
    const canGuess = ["drawing"].includes(game.status) && !meDrawer && !spectator && !game.guessedIds?.includes(state.clientId) && Date.now() >= state.guessCooldownUntil;
    $("guessInput").disabled = !canGuess;
    const guessButton = $("guessForm").querySelector("button");
    guessButton.disabled = !canGuess;
    guessButton.title = Date.now() < state.guessCooldownUntil ? "Please wait one second before another guess." : "";
  }
  function updateGameClock() {
    if (state.mode !== "game" || !state.game) return;
    const game = state.game;
    let seconds = 0;
    if (game.status === "drawing") seconds = Math.max(0, game.duration - (Date.now() - game.roundStartedAt) / 1000);
    if (game.status === "word_selection") seconds = Math.max(0, (game.wordChoiceDeadline - Date.now()) / 1000);
    $("gameTimer").textContent = `${String(Math.floor(seconds / 60)).padStart(2,"0")}:${String(Math.ceil(seconds % 60)).padStart(2,"0")}`;
  }
  function remoteCursor(msg) {
    let el = document.querySelector(`[data-cursor="${msg.clientId}"]`);
    if (!el) {
      el = document.createElement("span");
      el.className = "remote-cursor";
      el.dataset.cursor = msg.clientId;
      $("cursorLayer").append(el);
    }
    const s = screen({ x: msg.x, y: msg.y });
    el.textContent = msg.name;
    el.style.background = msg.color;
    el.style.transform = `translate(${s.x}px,${s.y}px)`;
    clearTimeout(el.timer);
    el.timer = setTimeout(() => el.remove(), 1000);
  }
  function toast(message) {
    const item = document.createElement("div");
    item.className = "toast";
    item.textContent = message;
    $("toastRegion").append(item);
    setTimeout(() => item.remove(), 2800);
  }
  function openModal(content) {
    $("modalContent").innerHTML = content;
    $("modal").hidden = false;
  }
  function closeModal() {
    $("modal").hidden = true;
  }
  function share() {
    const link = `${location.origin}${location.pathname}?room=${encodeURIComponent(state.room)}`;
    openModal(
      `<h2>Invite collaborators</h2><p>Everyone with this room link can view and edit this classroom board.</p><code class="share-code">${state.room}</code><div class="modal-actions"><button id="copyRoom">Copy room code</button><button id="copyLink" class="primary">Copy invite link</button></div>`,
    );
    $("copyRoom").onclick = () =>
      navigator.clipboard
        .writeText(state.room)
        .then(() => toast("Room code copied."));
    $("copyLink").onclick = () =>
      navigator.clipboard
        .writeText(link)
        .then(() => toast("Invite link copied."));
  }
  function help() {
    openModal(
      `<h2>Quick controls</h2><ul class="help-list"><li>V Select / move</li><li>P Pen</li><li>H Highlighter</li><li>E Eraser</li><li>R Rectangle</li><li>O Ellipse</li><li>L Line</li><li>A Arrow</li><li>B Double arrow</li><li>C Connector</li><li>T Text</li><li>S Sticky note</li><li>G Grid</li><li>Ctrl+C / Ctrl+V Copy / paste</li><li>Ctrl+D Duplicate</li><li>Ctrl+Z Undo</li><li>Delete selected</li><li>Wheel Zoom</li><li>Shift + drag Pan</li></ul>`,
    );
  }
  function positionEditor() {
    if (!state.editor) return;
    const box = $("textEditor");
    const pos = screen({ x: state.editor.object.x, y: state.editor.object.y });
    const sticky = state.editor.object.type === "sticky";
    box.style.left = `${pos.x}px`;
    box.style.top = `${pos.y}px`;
    box.style.width = `${Math.max(sticky ? 110 : 80, (state.editor.object.w || 190) * state.view.scale)}px`;
    box.style.height = `${Math.max(sticky ? 70 : 30, (state.editor.object.h || 30) * state.view.scale)}px`;
    box.style.fontSize = `${sticky ? 14 : Math.max(14, (state.editor.object.style?.width || 3) * 5) * state.view.scale}px`;
  }
  function finishEditor(commit = true) {
    if (!state.editor) return;
    const box = $("textEditor");
    const { object, original } = state.editor;
    const text = box.value.trimEnd();
    box.hidden = true;
    box.className = "";
    state.editor = null;
    if (!commit) return;
    // Empty new items are discarded. Existing items keep their prior content
    // only when editing is cancelled; committing an empty existing item deletes it.
    if (!text) {
      if (original) deleteObject(original);
      return;
    }
    const next = { ...object, text };
    if (original) update(next, original);
    else create(next);
  }
  function editor(object) {
    const box = $("textEditor");
    if (state.editor) finishEditor(true);
    const original = state.objects.get(object.id);
    state.editor = { object: clone(object), original: original ? clone(original) : null };
    const sticky = object.type === "sticky";
    box.value = object.text || "";
    box.placeholder = sticky ? "Type your note…" : "Type text…";
    box.className = sticky ? "sticky-editor" : "text-editor";
    positionEditor();
    box.hidden = false;
    box.focus();
    if (object.text) box.select();
    box.onblur = () => finishEditor(true);
    box.onkeydown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finishEditor(false);
      } else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        finishEditor(true);
      } else if (!sticky && event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        finishEditor(true);
      }
    };
  }
  function enterRoom(name, room, connectionAction, requestedMode = "whiteboard") {
    state.name = name;
    state.room = room;
    state.requestedMode = requestedMode;
    state.connectionAction = connectionAction;
    state.joinFailure = false;
    state.clientId = sessionStorage.getItem(`collabdraw:${room}`) || id("user");
    sessionStorage.setItem(`collabdraw:${room}`, state.clientId);
    sessionStorage.setItem(`collabdraw:name:${room}`, name);
    history.replaceState(null, "", `?room=${encodeURIComponent(room)}`);
    $("roomLabel").textContent = room;
    $("joinScreen").hidden = true;
    $("boardApp").hidden = false;
    resize();
    connect();
  }
  function showFlow(flow) {
    state.flow = flow;
    $("landingView").hidden = flow !== "landing";
    $("createView").hidden = flow !== "create";
    $("joinView").hidden = flow !== "join";
    $("joinError").textContent = "";
    if (flow === "create") {
      $("createNameInput").value ||= $("joinNameInput").value;
      $("createRoomInput").value ||= $("joinRoomInput").value;
      $("createNameInput").focus();
    }
    if (flow === "join") {
      $("joinNameInput").value ||= $("createNameInput").value;
      $("joinRoomInput").value ||= $("createRoomInput").value;
      $("joinNameInput").focus();
    }
  }
  function validateRoom(name, room, message) {
    if (!name || !room) {
      $("joinError").textContent = message;
      return false;
    }
    if (!roomPattern.test(room)) {
      $("joinError").textContent =
        "Use 2–24 letters, numbers or hyphens, starting with a letter or number.";
      return false;
    }
    return true;
  }
  function createRoom() {
    const name = $("createNameInput").value.trim();
    const room = normalizeRoom($("createRoomInput").value) || randomRoom();
    if (!validateRoom(name, room, "Enter your name. Leave the room code blank to generate one.")) return;
    $("createRoomInput").value = room;
    enterRoom(name, room, "create", state.selectedCreateMode);
  }
  function joinRoom() {
    const name = $("joinNameInput").value.trim();
    const room = normalizeRoom($("joinRoomInput").value);
    if (!validateRoom(name, room, "Enter your name and a room code.")) return;
    $("joinRoomInput").value = room;
    // A join deliberately has no selected mode. Redis metadata decides it.
    enterRoom(name, room, "join");
  }
  function randomRoom() {
    const words = [
      "BLUE",
      "MANGO",
      "RIVER",
      "EMBER",
      "NOVA",
      "MAPLE",
      "PIXEL",
      "CORAL",
      "CLOUD",
    ];
    return `${words[Math.floor(Math.random() * words.length)]}-${words[Math.floor(Math.random() * words.length)]}-${Math.floor(10 + Math.random() * 90)}`;
  }
  function png() {
    const a = document.createElement("a");
    a.download = `${state.room}-board.png`;
    a.href = canvas.toDataURL("image/png");
    a.click();
  }
  function jsonExport() {
    const data = {
      format: "CollabDraw v2",
      room: state.room,
      exportedAt: new Date().toISOString(),
      objects: [...state.objects.values()],
    };
    const a = document.createElement("a");
    a.download = `${state.room}-board.json`;
    a.href = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function importBoard(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.objects)) throw Error();
        const objects = data.objects.map((o) => ({
          ...o,
          id: id("obj"),
          userId: state.clientId,
        }));
        operation("board:replace", { objects }, false);
        toast("Imported board synchronized.");
      } catch {
        toast("That file is not a valid CollabDraw JSON export.");
      }
    };
    reader.readAsText(file);
  }
  function pointerDown(e) {
    if (state.editor) return;
    const p = world(e);
    if (e.button === 1 || e.shiftKey) {
      state.drag = {
        kind: "pan",
        x: e.clientX,
        y: e.clientY,
        view: { ...state.view },
      };
      return;
    }
    if (state.mode === "game" && !canDraw()) {
      toast("Watch the drawing and submit a guess.");
      return;
    }
    if (state.tool === "select") {
      const obj = hit(p);
      state.selected = obj?.id || null;
      if (obj) {
        const handle = resizeHandle(p, obj);
        state.drag = handle ? { kind: "resize", handle, object: clone(obj), start: p } : { kind: "move", object: clone(obj), start: p };
      }
      render();
      return;
    }
    if (state.tool === "eraser") {
      const obj = hit(p);
      if (obj) deleteObject(obj);
      return;
    }
    if (state.tool === "text" || state.tool === "sticky") {
      const object = {
        id: id("obj"),
        type: state.tool,
        userId: state.clientId,
        x: p.x,
        y: p.y,
        w: state.tool === "sticky" ? 190 : 200,
        h: state.tool === "sticky" ? 120 : 30,
        text: "",
        style: {
          ...style(),
          fill: state.tool === "sticky" ? "#fef3c7" : style().fill,
        },
      };
      // Wait until this canvas click has completed. Focusing synchronously in
      // pointerdown is immediately undone by the browser's remaining click
      // events, which made the old editor appear to lose focus.
      setTimeout(() => editor(object), 0);
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    if (state.tool === "pen" || state.tool === "highlighter")
      state.draft = {
        id: id("obj"),
        type: state.tool,
        x: p.x,
        y: p.y,
        points: [p],
        style: state.tool === "highlighter" ? { ...style(), width: Math.max(12, +$("widthInput").value), opacity: .28 } : style(),
      };
    else
      state.draft = {
        id: id("obj"),
        type: state.tool,
        x: p.x,
        y: p.y,
        w: 0,
        h: 0,
        style: style(),
      };
  }
  function pointerMove(e) {
    const p = world(e);
    if (state.drag?.kind === "pan") {
      state.view.x = state.drag.view.x + e.clientX - state.drag.x;
      state.view.y = state.drag.view.y + e.clientY - state.drag.y;
      render();
      return;
    }
    if (state.drag?.kind === "move") {
      const d = { ...state.drag.object };
      const dx = p.x - state.drag.start.x,
        dy = p.y - state.drag.start.y;
      if (d.type === "pen" || d.type === "highlighter")
        d.points = d.points.map((q) => ({ x: q.x + dx, y: q.y + dy }));
      else {
        d.x += dx;
        d.y += dy;
      }
      state.objects.set(d.id, d);
      render();
    } else if (state.drag?.kind === "resize") {
      const d = { ...state.drag.object }, b = bounds(d), min = 24;
      if (state.drag.handle.includes("w")) { d.x = Math.min(p.x, b.x + b.w - min); d.w = b.x + b.w - d.x; }
      if (state.drag.handle.includes("e")) d.w = Math.max(min, p.x - b.x);
      if (state.drag.handle.includes("n")) { d.y = Math.min(p.y, b.y + b.h - min); d.h = b.y + b.h - d.y; }
      if (state.drag.handle.includes("s")) d.h = Math.max(min, p.y - b.y);
      state.objects.set(d.id, d); render();
    } else if (state.draft) {
      if (state.draft.type === "pen" || state.draft.type === "highlighter") state.draft.points.push(p);
      else {
        state.draft.w = p.x - state.draft.x;
        state.draft.h = p.y - state.draft.y;
      }
      render();
    }
    if (!state.cursorTimer)
      state.cursorTimer = setTimeout(() => {
        if (state.socket?.readyState === WebSocket.OPEN)
          state.socket.send(JSON.stringify({ type: "cursor", x: p.x, y: p.y }));
        state.cursorTimer = null;
      }, 40);
  }
  function pointerUp() {
    if (state.drag?.kind === "move") {
      const next = state.objects.get(state.drag.object.id);
      update(next, state.drag.object);
      state.drag = null;
      return;
    }
    if (state.drag?.kind === "resize") {
      const next = state.objects.get(state.drag.object.id);
      update(next, state.drag.object); state.drag = null; return;
    }
    if (state.drag) {
      state.drag = null;
      return;
    }
    if (!state.draft) return;
    let object = state.draft;
    state.draft = null;
    if (["rectangle", "ellipse", "triangle", "diamond"].includes(object.type)) {
      const n = normalise(object.x, object.y, object.w, object.h);
      object = { ...object, ...n };
    }
    if (
      object.type === "pen" || object.type === "highlighter"
        ? object.points.length > 1
        : Math.abs(object.w) + Math.abs(object.h) > 2
    )
      create(object);
    else render();
  }
  function wheel(e) {
    e.preventDefault();
    const old = state.view.scale,
      next = Math.max(0.25, Math.min(3, old * (e.deltaY > 0 ? 0.9 : 1.1)));
    const r = canvas.getBoundingClientRect(),
      mx = e.clientX - r.left,
      my = e.clientY - r.top;
    state.view.x = mx - (mx - state.view.x) * (next / old);
    state.view.y = my - (my - state.view.y) * (next / old);
    state.view.scale = next;
    positionEditor();
    render();
  }
  $("showCreateBtn").onclick = () => showFlow("create");
  $("showJoinBtn").onclick = () => showFlow("join");
  document.querySelectorAll("[data-back]").forEach((button) => (button.onclick = () => showFlow("landing")));
  document.querySelectorAll("[data-create-mode]").forEach((button) => {
    button.onclick = () => {
      state.selectedCreateMode = button.dataset.createMode;
      document.querySelectorAll("[data-create-mode]").forEach((card) => {
        const active = card === button;
        card.classList.toggle("active", active);
        card.setAttribute("aria-checked", String(active));
      });
    };
  });
  $("createView").onsubmit = (event) => { event.preventDefault(); createRoom(); };
  $("joinView").onsubmit = (event) => { event.preventDefault(); joinRoom(); };
  const roomFromUrl = normalizeRoom(
    new URLSearchParams(location.search).get("room") || "",
  );
  const restoredName = roomFromUrl
    ? sessionStorage.getItem(`collabdraw:name:${roomFromUrl}`)
    : "";
  if (restoredName) {
    enterRoom(restoredName, roomFromUrl, "join");
  } else if (roomFromUrl) {
    $("joinRoomInput").value = roomFromUrl;
    showFlow("join");
  } else showFlow("landing");
  $("strokeColor").oninput = () => changeStyle("stroke", $("strokeColor").value);
  $("fillColor").oninput = () => changeStyle("fill", $("fillColor").value);
  $("widthInput").oninput = () => {
    changeStyle("width", +$("widthInput").value);
  };
  document.querySelectorAll(".swatches [data-color]").forEach((button) => button.onclick = () => changeStyle("stroke", button.dataset.color));
  document.querySelectorAll(".size-dots [data-width]").forEach((button) => button.onclick = () => changeStyle("width", +button.dataset.width));
  document
    .querySelectorAll(".tool")
    .forEach((button) => (button.onclick = () => button.dataset.menu ? openToolMenu(button.dataset.menu, button) : setTool(button.dataset.tool)));
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("dblclick", (event) => {
    if (state.tool !== "select" || state.editor) return;
    const object = hit(world(event));
    if (object && (object.type === "text" || object.type === "sticky")) editor(clone(object));
  });
  canvas.addEventListener("wheel", wheel, { passive: false });
  document.addEventListener("pointerdown", (event) => { if (!event.target.closest("#toolbar, #toolMenu")) closeToolMenu(); });
  $("undoBtn").onclick = undo;
  $("redoBtn").onclick = redo;
  $("clearBtn").onclick = () =>
    openModal(
      '<h2>Clear this board?</h2><p>This removes every object for everyone in the room. This action cannot be undone.</p><div class="modal-actions"><button id="cancelClear">Cancel</button><button id="confirmClear" class="danger">Clear board</button></div>',
    );
  $("modalClose").onclick = closeModal;
  $("modal").onclick = (e) => {
    if (e.target === $("modal")) closeModal();
  };
  document.addEventListener("click", (e) => {
    if (e.target.id === "cancelClear") closeModal();
    if (e.target.id === "confirmClear") {
      operation("board:clear", {}, false);
      closeModal();
    }
  });
  $("zoomIn").onclick = () => {
    state.view.scale = Math.min(3, state.view.scale * 1.2);
    render();
  };
  $("zoomOut").onclick = () => {
    state.view.scale = Math.max(0.25, state.view.scale / 1.2);
    render();
  };
  $("zoomReset").onclick = () => {
    state.view = { x: 0, y: 0, scale: 1 };
    render();
  };
  document.querySelectorAll("[data-object-action]").forEach((button) => {
    button.onclick = () => {
      const action = button.dataset.objectAction;
      if (action === "duplicate") duplicate();
      else if (action === "delete") { const object = state.objects.get(state.selected); if (object) deleteObject(object); }
      else reorderSelected(action);
    };
  });
  $("shareBtn").onclick = share;
  $("roomButton").onclick = share;
  $("helpBtn").onclick = help;
  $("startGameBtn").onclick = () => sendGame("game:start");
  $("roundsInput").onchange = () => sendGame("game:settings", { rounds: +$("roundsInput").value, duration: +$("durationInput").value });
  $("durationInput").onchange = () => sendGame("game:settings", { rounds: +$("roundsInput").value, duration: +$("durationInput").value });
  $("playAgainBtn").onclick = () => sendGame("game:again");
  $("gameClearBtn").onclick = () => operation("board:clear", {}, false);
  $("guessForm").onsubmit = (e) => {
    e.preventDefault();
    const text = $("guessInput").value.trim();
    if (!text) return;
    if (Date.now() < state.guessCooldownUntil) {
      toast("Please wait a moment before another guess.");
      return;
    }
    sendGame("game:guess", { text });
    $("guessInput").value = "";
    state.guessCooldownUntil = Date.now() + 1000;
    renderGame();
    setTimeout(renderGame, 1000);
  };
  $("leaveBtn").onclick = () => {
    state.socket?.close();
    location.href = location.pathname;
  };
  $("exportBtn").onclick = () => {
    $("fileMenu").hidden = !$("fileMenu").hidden;
  };
  document.querySelectorAll("[data-file]").forEach(
    (b) =>
      (b.onclick = () => {
        const action = b.dataset.file;
        $("fileMenu").hidden = true;
        if (action === "png") png();
        if (action === "json") jsonExport();
        if (action === "import") $("importInput").click();
      }),
  );
  $("importInput").onchange = (e) => {
    if (e.target.files[0]) importBoard(e.target.files[0]);
    e.target.value = "";
  };
  window.addEventListener("resize", resize);
  setInterval(() => { updateGameClock(); if (state.mode === "game" && state.game && ["word_selection", "drawing", "round_results"].includes(state.game.status)) sendGame("game:tick"); }, 1000);
  window.addEventListener("keydown", (e) => {
    if (state.editor || document.activeElement === $("textEditor") || ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      const object = state.objects.get(state.selected); if (object) { state.clipboard = clone(object); toast("Object copied."); } return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") { e.preventDefault(); if (state.clipboard) duplicate(state.clipboard); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); duplicate(); return; }
    if (e.key === "Delete" && state.selected) {
      const o = state.objects.get(state.selected);
      if (o) deleteObject(o);
      return;
    }
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const keys = {
        v: "select",
        p: "pen",
        h: "highlighter",
        e: "eraser",
        r: "rectangle",
        o: "ellipse",
        l: "line",
        a: "arrow",
        b: "double_arrow",
        c: "connector",
        t: "text",
        s: "sticky",
        n: "sticky",
        g: "grid",
        r: "rectangle",
      };
      const choice = keys[e.key.toLowerCase()];
      if (choice === "grid") { state.grid = !state.grid; workspace.classList.toggle("grid-visible", state.grid); toast(`Grid ${state.grid ? "shown" : "hidden"}.`); }
      else if (choice) setTool(choice);
    }
  });
})();

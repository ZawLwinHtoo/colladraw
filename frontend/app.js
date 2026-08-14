/**
 * Distributed Real-Time Collaborative Whiteboard - Frontend Application Engine
 */

(function () {
    'use strict';

    // ==========================================================================
    // State Initialization & Configuration
    // ==========================================================================
    let clientId = sessionStorage.getItem('collabdraw_client_id');
    if (!clientId) {
        clientId = 'user-' + Math.random().toString(36).substring(2, 9);
        sessionStorage.setItem('collabdraw_client_id', clientId);
    }
    
    // Vibrant Palette for User Badges
    const userColors = ['#38bdf8', '#a855f7', '#ec4899', '#f43f5e', '#10b981', '#f59e0b', '#6366f1'];
    
    // Retrieve stored user presence profile or generate defaults
    let userName = localStorage.getItem('collabdraw_username') || '';
    let userColor = localStorage.getItem('collabdraw_usercolor') || userColors[Math.floor(Math.random() * userColors.length)];

    let roomId = getRoomIdFromURL() || 'default-room';
    let socket = null;
    let isConnected = false;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    let reconnectTimeout = null;

    // Tool & Canvas State
    let currentTool = 'pen';
    let strokeColor = '#ffffff';
    let strokeSize = 4;
    let isDrawing = false;
    let startX = 0;
    let startY = 0;
    let currentPoints = [];
    let isAutoCleanEnabled = false;
    let currentBgPattern = 'grid';
    let isVoiceActive = false;
    const stickyNotesMap = new Map(); // note_id -> DOM element & data
    
    // Canvas History: list of action objects
    let canvasHistory = [];
    let activeUsers = [];
    const remoteCursors = new Map(); // clientId -> DOM Element

    // DOM Element References
    const canvas = document.getElementById('whiteboardCanvas');
    const ctx = canvas.getContext('2d');
    const cursorOverlay = document.getElementById('cursorOverlay');
    const stickyNotesContainer = document.getElementById('stickyNotesContainer');
    const roomInput = document.getElementById('roomInput');
    const joinRoomBtn = document.getElementById('joinRoomBtn');
    const copyShareBtn = document.getElementById('copyShareBtn');
    const editProfileBtn = document.getElementById('editProfileBtn');
    const connectionBadge = document.getElementById('connectionBadge');
    const statusText = document.getElementById('statusText');
    const avatarStack = document.getElementById('avatarStack');
    const sizeSlider = document.getElementById('sizeSlider');
    const sizeValueDisplay = document.getElementById('sizeValueDisplay');
    const customColorPicker = document.getElementById('customColorPicker');
    const undoBtn = document.getElementById('undoBtn');
    const clearBtn = document.getElementById('clearBtn');
    const exportBtn = document.getElementById('exportBtn');
    const exportSvgBtn = document.getElementById('exportSvgBtn');
    const exportPdfBtn = document.getElementById('exportPdfBtn');
    const autoCleanBtn = document.getElementById('autoCleanBtn');
    const bgPatternSelect = document.getElementById('bgPatternSelect');
    const voiceChatBtn = document.getElementById('voiceChatBtn');
    const aiDiagramBtn = document.getElementById('aiDiagramBtn');
    const toast = document.getElementById('toast');
    const toastMessage = document.getElementById('toastMessage');

    // Blind Chain Draw Game Mode DOM Elements & State
    const createGameBtn = document.getElementById('createGameBtn');
    const startGameBtn = document.getElementById('startGameBtn');
    const gameHudBar = document.getElementById('gameHudBar');
    const gamePromptText = document.getElementById('gamePromptText');
    const gameTimerDisplay = document.getElementById('gameTimerDisplay');
    const gameTurnDisplay = document.getElementById('gameTurnDisplay');
    const finishTurnBtn = document.getElementById('finishTurnBtn');

    const revealModal = document.getElementById('revealModal');
    const closeRevealModalBtn = document.getElementById('closeRevealModalBtn');
    const playAgainBtn = document.getElementById('playAgainBtn');
    const quitRevealBtn = document.getElementById('quitRevealBtn');
    const revealPromptText = document.getElementById('revealPromptText');
    const revealCanvas = document.getElementById('revealCanvas');
    const revealContributors = document.getElementById('revealContributors');
    // Game Stage Arena DOM Elements
    const gameStageModal = document.getElementById('gameStageModal');
    const arenaPromptText = document.getElementById('arenaPromptText');
    const arenaTimerDisplay = document.getElementById('arenaTimerDisplay');
    const arenaTurnDisplay = document.getElementById('arenaTurnDisplay');
    const arenaFinishTurnBtn = document.getElementById('arenaFinishTurnBtn');
    const arenaCanvas = document.getElementById('arenaCanvas');
    const arenaColorPicker = document.getElementById('arenaColorPicker');
    const arenaUndoBtn = document.getElementById('arenaUndoBtn');
    const arenaClearBtn = document.getElementById('arenaClearBtn');

    // Room Gateway Lobby Gateway DOM Elements
    const roomGatewayModal = document.getElementById('roomGatewayModal');
    const gatewayNameInput = document.getElementById('gatewayNameInput');
    const gatewayAvatarPreview = document.getElementById('gatewayAvatarPreview');
    const gatewayAvatarInitials = document.getElementById('gatewayAvatarInitials');
    const gatewayCreateBtn = document.getElementById('gatewayCreateBtn');
    const gatewayJoinBtn = document.getElementById('gatewayJoinBtn');
    const gatewayRoomCodeInput = document.getElementById('gatewayRoomCodeInput');
    const currentRoomCodeDisplay = document.getElementById('currentRoomCodeDisplay');
    const copyRoomCodeBtn = document.getElementById('copyRoomCodeBtn');
    // Presence Modal & AI Diagram Modal Elements
    const presenceModal = document.getElementById('presenceModal');
    const presenceForm = document.getElementById('presenceForm');
    const displayNameInput = document.getElementById('displayNameInput');
    const modalAvatarPreview = document.getElementById('modalAvatarPreview');
    const modalAvatarInitials = document.getElementById('modalAvatarInitials');
    const modalColorPicker = document.getElementById('modalColorPicker');
    const closePresenceModalBtn = document.getElementById('closePresenceModalBtn');

    const aiDiagramModal = document.getElementById('aiDiagramModal');
    const closeAiModalBtn = document.getElementById('closeAiModalBtn');
    const aiDiagramForm = document.getElementById('aiDiagramForm');
    const aiPromptInput = document.getElementById('aiPromptInput');

    let isGameMode = false;
    let isHost = false;
    let gameStatus = 'none'; // 'none' | 'lobby' | 'playing' | 'reveal'
    let previousLayers = {}; // turn_index -> actions array
    let activeGameTurn = 0;
    let isMyTurn = false;

    // DOM Element References for Chat Sidebar
    const chatToggleBtn = document.getElementById('chatToggleBtn');
    const closeChatBtn = document.getElementById('closeChatBtn');
    const chatSidebar = document.getElementById('chatSidebar');
    const chatMessages = document.getElementById('chatMessages');
    const chatForm = document.getElementById('chatForm');
    const chatInput = document.getElementById('chatInput');
    const unreadBadge = document.getElementById('unreadBadge');
    const emojiToggleBtn = document.getElementById('emojiToggleBtn');
    const emojiPickerGrid = document.getElementById('emojiPickerGrid');
    const quickEmojiBar = document.getElementById('quickEmojiBar');

    let unreadChatCount = 0;

    // Set initial room code display value
    if (currentRoomCodeDisplay) currentRoomCodeDisplay.textContent = roomId;
    if (roomInput) roomInput.value = roomId;

    // ==========================================================================
    // Chat Sidebar Logic & Event Handlers
    // ==========================================================================
    function toggleChatSidebar() {
        if (chatSidebar.classList.contains('collapsed')) {
            openChatSidebar();
        } else {
            closeChatSidebar();
        }
    }

    function openChatSidebar() {
        chatSidebar.classList.remove('collapsed');
        unreadChatCount = 0;
        unreadBadge.textContent = '0';
        unreadBadge.classList.add('hidden');
        setTimeout(() => chatInput.focus(), 150);
        scrollChatToBottom();
    }

    function closeChatSidebar() {
        chatSidebar.classList.add('collapsed');
        if (emojiPickerGrid) emojiPickerGrid.classList.add('hidden');
    }

    function scrollChatToBottom() {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    if (chatToggleBtn) chatToggleBtn.addEventListener('click', toggleChatSidebar);
    if (closeChatBtn) closeChatBtn.addEventListener('click', closeChatSidebar);

    // Quick Emoji Reaction Chips
    if (quickEmojiBar) {
        quickEmojiBar.querySelectorAll('.emoji-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const emoji = chip.dataset.emoji;
                if (chatInput) {
                    chatInput.value += emoji;
                    chatInput.focus();
                }
            });
        });
    }

    // Emoji Picker Grid Toggle & Click Selection
    if (emojiToggleBtn && emojiPickerGrid) {
        emojiToggleBtn.addEventListener('click', () => {
            emojiPickerGrid.classList.toggle('hidden');
        });

        emojiPickerGrid.querySelectorAll('.emoji-picker-item').forEach(item => {
            item.addEventListener('click', () => {
                const emoji = item.dataset.emoji;
                if (chatInput) {
                    chatInput.value += emoji;
                    chatInput.focus();
                }
                emojiPickerGrid.classList.add('hidden');
            });
        });
    }

    if (chatForm) {
        chatForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = chatInput ? chatInput.value.trim() : '';
            if (!text) return;

            if (emojiPickerGrid) emojiPickerGrid.classList.add('hidden');

            const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const chatPayload = {
                type: 'chat',
                text: text,
                name: userName,
                color: userColor,
                timestamp: timeStr
            };

            sendWebSocketMessage(chatPayload);
            if (chatInput) chatInput.value = '';
        });
    }

    function appendChatMessage(msg) {
        const isSelf = msg.client_id === clientId;
        const wrapper = document.createElement('div');
        wrapper.className = `chat-bubble-wrapper ${isSelf ? 'self' : 'peer'}`;

        const meta = document.createElement('div');
        meta.className = 'chat-meta';
        
        const nameSpan = document.createElement('span');
        nameSpan.className = 'chat-sender-name';
        nameSpan.style.color = isSelf ? 'var(--text-primary)' : (msg.color || 'var(--accent-neon)');
        nameSpan.textContent = isSelf ? 'You' : msg.name;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'chat-timestamp';
        timeSpan.textContent = msg.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        meta.appendChild(nameSpan);
        meta.appendChild(timeSpan);

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.textContent = msg.text;

        wrapper.appendChild(meta);
        wrapper.appendChild(bubble);

        chatMessages.appendChild(wrapper);
        scrollChatToBottom();

        // Handle unread indicator badge if chat is closed
        if (chatSidebar.classList.contains('collapsed') && !isSelf) {
            unreadChatCount++;
            unreadBadge.textContent = unreadChatCount > 9 ? '9+' : unreadChatCount;
            unreadBadge.classList.remove('hidden');
        }
    }


    // ==========================================================================
    // User Presence Profile & Initials Utility
    // ==========================================================================
    function getInitials(name) {
        if (!name || !name.trim()) return 'U';
        const parts = name.trim().split(/\s+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return name.trim().substring(0, 2).toUpperCase();
    }

    function showPresenceModal(isEditing = false) {
        if (!presenceModal) return;
        const defaultName = userName || `User #${Math.floor(1000 + Math.random() * 9000)}`;
        if (displayNameInput) displayNameInput.value = defaultName;
        if (modalAvatarPreview) modalAvatarPreview.style.backgroundColor = userColor;
        if (modalAvatarInitials) modalAvatarInitials.textContent = getInitials(defaultName);

        if (modalColorPicker) {
            modalColorPicker.querySelectorAll('.avatar-color-swatch').forEach(swatch => {
                if (swatch.dataset.color === userColor) {
                    swatch.classList.add('active');
                } else {
                    swatch.classList.remove('active');
                }
            });
        }

        presenceModal.classList.remove('hidden');
        if (displayNameInput) {
            setTimeout(() => {
                displayNameInput.focus();
                displayNameInput.select();
            }, 100);
        }
    }

    // Modal Live Event Listeners
    if (displayNameInput) {
        displayNameInput.addEventListener('input', (e) => {
            const val = e.target.value.trim() || 'User';
            if (modalAvatarInitials) modalAvatarInitials.textContent = getInitials(val);
        });
    }

    if (modalColorPicker) {
        modalColorPicker.querySelectorAll('.avatar-color-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => {
                modalColorPicker.querySelectorAll('.avatar-color-swatch').forEach(s => s.classList.remove('active'));
                swatch.classList.add('active');
                userColor = swatch.dataset.color;
                if (modalAvatarPreview) modalAvatarPreview.style.backgroundColor = userColor;
            });
        });
    }

    if (closePresenceModalBtn) {
        closePresenceModalBtn.addEventListener('click', () => {
            if (presenceModal) presenceModal.classList.add('hidden');
            if (!userName && displayNameInput) {
                userName = displayNameInput.value.trim() || `User #${Math.floor(1000 + Math.random() * 9000)}`;
                localStorage.setItem('collabdraw_username', userName);
                localStorage.setItem('collabdraw_usercolor', userColor);
            }
            if (!isConnected) {
                connectWebSocket();
            }
        });
    }

    if (presenceForm) {
        presenceForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const inputName = displayNameInput ? displayNameInput.value.trim() : '';
            userName = inputName || `User #${Math.floor(1000 + Math.random() * 9000)}`;

            // Save preferences to localStorage
            localStorage.setItem('collabdraw_username', userName);
            localStorage.setItem('collabdraw_usercolor', userColor);

            if (presenceModal) presenceModal.classList.add('hidden');
            showToast(`Profile updated: ${userName}`);

            // Reconnect WebSocket with updated credentials so server & peers receive new profile
            connectWebSocket();
        });
    }

    if (editProfileBtn) {
        editProfileBtn.addEventListener('click', () => {
            if (gatewayNameInput) gatewayNameInput.value = userName;
            if (roomGatewayModal) {
                roomGatewayModal.classList.remove('hidden');
                roomGatewayModal.style.display = 'flex';
            }
        });
    }

    // ==========================================================================
    // Canvas High-DPI Setup & Window Resizing
    // ==========================================================================
    let dpr = window.devicePixelRatio || 1;

    function resizeCanvas() {
        dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        
        // Reset scale and re-render existing history
        redrawFullCanvas();
    }

    window.addEventListener('resize', resizeCanvas);

    // ==========================================================================
    // Drawing Engine & Canvas Operations
    // ==========================================================================
    function getCanvasCoordinates(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        // Normalized relative coordinates (0 to 1) for seamless multi-resolution sync
        return {
            x: (clientX - rect.left) / rect.width,
            y: (clientY - rect.top) / rect.height,
            px: clientX - rect.left,
            py: clientY - rect.top
        };
    }

    function redrawFullCanvas() {
        const rect = canvas.getBoundingClientRect();
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const width = rect.width;
        const height = rect.height;

        ctx.save();
        ctx.scale(dpr, dpr);

        if (currentBgPattern === 'light') {
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(0, 0, width, height);
            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1;
            for (let x = 0; x < width; x += 30) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                ctx.stroke();
            }
            for (let y = 0; y < height; y += 30) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(width, y);
                ctx.stroke();
            }
        } else if (currentBgPattern === 'dark') {
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, width, height);
        } else if (currentBgPattern === 'dots') {
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, width, height);
            ctx.fillStyle = '#334155';
            for (let x = 15; x < width; x += 24) {
                for (let y = 15; y < height; y += 24) {
                    ctx.beginPath();
                    ctx.arc(x, y, 1.5, 0, 2 * Math.PI);
                    ctx.fill();
                }
            }
        } else {
            // Default Grid Lines
            ctx.fillStyle = '#0f172a';
            ctx.fillRect(0, 0, width, height);
            ctx.strokeStyle = '#1e293b';
            ctx.lineWidth = 1;
            for (let x = 0; x < width; x += 30) {
                ctx.beginPath();
                ctx.moveTo(x, 0);
                ctx.lineTo(x, height);
                ctx.stroke();
            }
            for (let y = 0; y < height; y += 30) {
                ctx.beginPath();
                ctx.moveTo(0, y);
                ctx.lineTo(width, y);
                ctx.stroke();
            }
        }

        // Replay all actions in history
        if (gameStatus === 'playing') {
            // Render previous turn layers with blur & opacity filter
            ctx.save();
            try {
                ctx.filter = 'blur(8px) opacity(0.35)';
            } catch (e) {}

            Object.keys(previousLayers).forEach(lIdx => {
                const actions = previousLayers[lIdx] || [];
                actions.forEach(act => renderAction(act, rect));
            });
            ctx.restore();

            // Render current player's active layer sharp
            canvasHistory.forEach(action => {
                renderAction(action, rect);
            });
        } else {
            // Standard drawing mode
            canvasHistory.forEach(action => {
                renderAction(action, rect);
            });
        }

        ctx.restore();
    }

    function renderActionOnCtx(targetCtx, action, rect) {
        if (!targetCtx || !action) return;
        const width = rect ? rect.width : canvas.width / dpr;
        const height = rect ? rect.height : canvas.height / dpr;

        targetCtx.save();
        targetCtx.lineCap = 'round';
        targetCtx.lineJoin = 'round';
        targetCtx.lineWidth = action.size || 2;

        if (action.tool === 'eraser') {
            targetCtx.strokeStyle = '#0f172a';
        } else {
            targetCtx.strokeStyle = action.color || '#ffffff';
        }

        if (action.tool === 'pen' || action.tool === 'eraser') {
            if (action.points && action.points.length > 0) {
                targetCtx.beginPath();
                const p0 = action.points[0];
                targetCtx.moveTo(p0.x * width, p0.y * height);

                for (let i = 1; i < action.points.length; i++) {
                    const p = action.points[i];
                    targetCtx.lineTo(p.x * width, p.y * height);
                }
                targetCtx.stroke();
            }
        } else if (action.tool === 'line') {
            targetCtx.beginPath();
            targetCtx.moveTo(action.startX * width, action.startY * height);
            targetCtx.lineTo(action.endX * width, action.endY * height);
            targetCtx.stroke();
        } else if (action.tool === 'rect') {
            targetCtx.beginPath();
            const x = action.startX * width;
            targetCtx.strokeRect(x, action.startY * height, (action.endX - action.startX) * width, (action.endY - action.startY) * height);
        } else if (action.tool === 'circle') {
            targetCtx.beginPath();
            const startX = action.startX * width;
            const startY = action.startY * height;
            const endX = action.endX * width;
            const endY = action.endY * height;
            const radius = Math.sqrt(Math.pow(endX - startX, 2) + Math.pow(endY - startY, 2));
            targetCtx.arc(startX, startY, radius, 0, 2 * Math.PI);
            targetCtx.stroke();
        }
        targetCtx.restore();
    }

    function renderAction(action, rect) {
        renderActionOnCtx(ctx, action, rect);
    }

    // Live preview during drawing (rubber-banding)
    function renderDraftShape(coords) {
        redrawFullCanvas();

        const rect = canvas.getBoundingClientRect();
        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = strokeSize;
        ctx.strokeStyle = currentTool === 'eraser' ? '#0f172a' : strokeColor;

        const width = rect.width;
        const height = rect.height;

        if (currentTool === 'pen' || currentTool === 'eraser') {
            ctx.beginPath();
            if (currentPoints.length > 0) {
                ctx.moveTo(currentPoints[0].x * width, currentPoints[0].y * height);
                for (let i = 1; i < currentPoints.length; i++) {
                    ctx.lineTo(currentPoints[i].x * width, currentPoints[i].y * height);
                }
            }
            ctx.stroke();
        } else if (currentTool === 'line') {
            ctx.beginPath();
            ctx.moveTo(startX * width, startY * height);
            ctx.lineTo(coords.x * width, coords.y * height);
            ctx.stroke();
        } else if (currentTool === 'rect') {
            ctx.beginPath();
            const x = startX * width;
            const y = startY * height;
            const w = (coords.x - startX) * width;
            const h = (coords.y - startY) * height;
            ctx.strokeRect(x, y, w, h);
        } else if (currentTool === 'circle') {
            ctx.beginPath();
            const sx = startX * width;
            const sy = startY * height;
            const ex = coords.x * width;
            const ey = coords.y * height;
            const radius = Math.sqrt(Math.pow(ex - sx, 2) + Math.pow(ey - sy, 2));
            ctx.arc(sx, sy, radius, 0, 2 * Math.PI);
            ctx.stroke();
        }

        ctx.restore();
    }

    // ==========================================================================
    // Sticky Notes & Interactive DOM Text Cards
    // ==========================================================================
    function createStickyNote(noteData, isLocal = true) {
        if (stickyNotesMap.has(noteData.note_id)) {
            updateStickyNoteDOM(noteData);
            return;
        }

        const noteEl = document.createElement('div');
        noteEl.className = 'sticky-note';
        noteEl.style.backgroundColor = noteData.color || '#fef08a';

        const rect = canvas.getBoundingClientRect();
        noteEl.style.left = `${(noteData.x || 0.4) * rect.width}px`;
        noteEl.style.top = `${(noteData.y || 0.4) * rect.height}px`;

        const header = document.createElement('div');
        header.className = 'sticky-note-header';

        const colorList = document.createElement('div');
        colorList.className = 'sticky-color-swatch-list';
        const colors = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8'];
        colors.forEach(c => {
            const dot = document.createElement('div');
            dot.className = 'sticky-mini-dot';
            dot.style.backgroundColor = c;
            dot.addEventListener('click', (e) => {
                e.stopPropagation();
                noteEl.style.backgroundColor = c;
                noteData.color = c;
                sendWebSocketMessage({
                    type: 'sticky_update',
                    note_id: noteData.note_id,
                    x: noteData.x,
                    y: noteData.y,
                    color: c,
                    text: noteData.text
                });
            });
            colorList.appendChild(dot);
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'sticky-delete-btn';
        deleteBtn.innerHTML = '&times;';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            noteEl.remove();
            stickyNotesMap.delete(noteData.note_id);
            sendWebSocketMessage({
                type: 'sticky_delete',
                note_id: noteData.note_id
            });
        });

        header.appendChild(colorList);
        header.appendChild(deleteBtn);

        const textarea = document.createElement('textarea');
        textarea.className = 'sticky-note-textarea';
        textarea.value = noteData.text || '';
        textarea.placeholder = 'Type notes...';

        textarea.addEventListener('input', () => {
            noteData.text = textarea.value;
            sendWebSocketMessage({
                type: 'sticky_update',
                note_id: noteData.note_id,
                x: noteData.x,
                y: noteData.y,
                color: noteData.color,
                text: textarea.value
            });
        });

        // Dragging sticky note
        let isDraggingNote = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        header.addEventListener('mousedown', (e) => {
            isDraggingNote = true;
            const noteRect = noteEl.getBoundingClientRect();
            dragOffsetX = e.clientX - noteRect.left;
            dragOffsetY = e.clientY - noteRect.top;
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDraggingNote) return;
            const cRect = canvas.getBoundingClientRect();
            const posX = Math.max(0, Math.min(cRect.width - 170, e.clientX - cRect.left - dragOffsetX));
            const posY = Math.max(0, Math.min(cRect.height - 150, e.clientY - cRect.top - dragOffsetY));

            noteEl.style.left = `${posX}px`;
            noteEl.style.top = `${posY}px`;

            noteData.x = posX / cRect.width;
            noteData.y = posY / cRect.height;

            sendWebSocketMessage({
                type: 'sticky_update',
                note_id: noteData.note_id,
                x: noteData.x,
                y: noteData.y,
                color: noteData.color,
                text: textarea.value
            });
        });

        window.addEventListener('mouseup', () => {
            isDraggingNote = false;
        });

        noteEl.appendChild(header);
        noteEl.appendChild(textarea);
        stickyNotesContainer.appendChild(noteEl);

        stickyNotesMap.set(noteData.note_id, { el: noteEl, data: noteData, textarea });

        if (isLocal) {
            sendWebSocketMessage({
                type: 'sticky_create',
                note_id: noteData.note_id,
                x: noteData.x,
                y: noteData.y,
                color: noteData.color,
                text: noteData.text
            });
        }
    }

    function updateStickyNoteDOM(noteData) {
        const item = stickyNotesMap.get(noteData.note_id);
        if (!item) return;

        const cRect = canvas.getBoundingClientRect();
        item.el.style.left = `${(noteData.x || 0) * cRect.width}px`;
        item.el.style.top = `${(noteData.y || 0) * cRect.height}px`;
        if (noteData.color) item.el.style.backgroundColor = noteData.color;
        if (noteData.text !== undefined && document.activeElement !== item.textarea) {
            item.textarea.value = noteData.text;
        }
        item.data = { ...item.data, ...noteData };
    }

    function deleteStickyNoteDOM(note_id) {
        const item = stickyNotesMap.get(note_id);
        if (item) {
            item.el.remove();
            stickyNotesMap.delete(note_id);
        }
    }

    // ==========================================================================
    // Pointer Events Handlers
    // ==========================================================================
    function handlePointerDown(e) {
        if (isDrawingLocked && !isHost) {
            showToast('🔒 Drawing permissions locked by Room Host');
            isDrawing = false;
            return;
        }

        const coords = getCanvasCoordinates(e);

        if (currentTool === 'sticky') {
            const newNoteId = 'sticky-' + Math.random().toString(36).substring(2, 9);
            createStickyNote({
                note_id: newNoteId,
                x: coords.x,
                y: coords.y,
                color: '#fef08a',
                text: 'New Sticky Note'
            }, true);
            isDrawing = false;
            return;
        }

        isDrawing = true;
        startX = coords.x;
        startY = coords.y;
        currentPoints = [{ x: coords.x, y: coords.y }];
    }

    function handlePointerMove(e) {
        const coords = getCanvasCoordinates(e);

        // Broadcast cursor movement to peer nodes
        sendCursorPosition(coords.x, coords.y);

        if (!isDrawing) return;

        if (currentTool === 'pen' || currentTool === 'eraser') {
            currentPoints.push({ x: coords.x, y: coords.y });
        }

        renderDraftShape(coords);
    }

    function handlePointerUp(e) {
        if (!isDrawing) return;
        isDrawing = false;

        const coords = getCanvasCoordinates(e);
        let action = null;

        if (currentTool === 'pen') {
            if (isAutoCleanEnabled && currentPoints.length > 5) {
                // Auto-Clean Shape snapping algorithm
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                currentPoints.forEach(p => {
                    if (p.x < minX) minX = p.x;
                    if (p.x > maxX) maxX = p.x;
                    if (p.y < minY) minY = p.y;
                    if (p.y > maxY) maxY = p.y;
                });

                const w = maxX - minX;
                const h = maxY - minY;
                const distSE = Math.hypot(startX - coords.x, startY - coords.y);
                const diag = Math.hypot(w, h);

                if (distSE / (diag || 1) < 0.35) {
                    // Closed shape
                    const ratio = w / (h || 1);
                    if (ratio >= 0.7 && ratio <= 1.4) {
                        // Snap to Circle
                        const centerX = minX + w / 2;
                        const centerY = minY + h / 2;
                        const rad = Math.max(w, h) / 2;
                        action = {
                            type: 'draw',
                            tool: 'circle',
                            color: strokeColor,
                            size: strokeSize,
                            startX: centerX,
                            startY: centerY,
                            endX: centerX + rad,
                            endY: centerY
                        };
                        showToast('🪄 Snapped to Circle');
                    } else {
                        // Snap to Rectangle
                        action = {
                            type: 'draw',
                            tool: 'rect',
                            color: strokeColor,
                            size: strokeSize,
                            startX: minX,
                            startY: minY,
                            endX: maxX,
                            endY: maxY
                        };
                        showToast('🪄 Snapped to Rectangle');
                    }
                } else {
                    // Open path -> Snap to Straight Line
                    action = {
                        type: 'draw',
                        tool: 'line',
                        color: strokeColor,
                        size: strokeSize,
                        startX: startX,
                        startY: startY,
                        endX: coords.x,
                        endY: coords.y
                    };
                    showToast('🪄 Snapped to Line');
                }
            } else if (currentPoints.length > 0) {
                action = {
                    type: 'draw',
                    tool: 'pen',
                    color: strokeColor,
                    size: strokeSize,
                    points: currentPoints
                };
            }
        } else if (currentTool === 'eraser') {
            if (currentPoints.length > 0) {
                action = {
                    type: 'draw',
                    tool: 'eraser',
                    color: strokeColor,
                    size: strokeSize,
                    points: currentPoints
                };
            }
        } else if (currentTool === 'line') {
            action = {
                type: 'draw',
                tool: 'line',
                color: strokeColor,
                size: strokeSize,
                startX: startX,
                startY: startY,
                endX: coords.x,
                endY: coords.y
            };
        } else if (currentTool === 'rect') {
            action = {
                type: 'draw',
                tool: 'rect',
                color: strokeColor,
                size: strokeSize,
                startX: startX,
                startY: startY,
                endX: coords.x,
                endY: coords.y
            };
        } else if (currentTool === 'circle') {
            action = {
                type: 'draw',
                tool: 'circle',
                color: strokeColor,
                size: strokeSize,
                startX: startX,
                startY: startY,
                endX: coords.x,
                endY: coords.y
            };
        }

        if (action) {
            // Local optimistic record & render
            canvasHistory.push(action);
            redrawFullCanvas();

            // Broadcast action via WebSocket
            sendWebSocketMessage(action);
        }

        currentPoints = [];
    }

    // Event Bindings for Canvas
    canvas.addEventListener('mousedown', handlePointerDown);
    canvas.addEventListener('mousemove', handlePointerMove);
    canvas.addEventListener('mouseup', handlePointerUp);
    canvas.addEventListener('mouseleave', handlePointerUp);

    canvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        handlePointerDown(e);
    });
    canvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        handlePointerMove(e);
    });
    canvas.addEventListener('touchend', (e) => {
        e.preventDefault();
        handlePointerUp(e);
    });

    // ==========================================================================
    // Dedicated Game Stage Arena Canvas Drawing Engine
    // ==========================================================================
    let arenaTool = 'pen';
    let arenaColor = '#38bdf8';
    let arenaSize = 4;
    let arenaCurrentPoints = [];
    let arenaIsDrawing = false;
    let arenaStartX = 0;
    let arenaStartY = 0;
    let arenaGameHistory = [];

    function resizeArenaCanvas() {
        if (!arenaCanvas) return;
        const rect = arenaCanvas.parentElement.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            arenaCanvas.width = rect.width * dpr;
            arenaCanvas.height = rect.height * dpr;
            redrawArenaCanvas();
        }
    }

    function redrawArenaCanvas() {
        if (!arenaCanvas) return;
        const ctx = arenaCanvas.getContext('2d');
        const rect = arenaCanvas.parentElement.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        ctx.save();
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, width, height);

        // Draw arena grid background
        ctx.strokeStyle = '#1e293b';
        ctx.lineWidth = 1;
        for (let x = 0; x < width; x += 30) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        for (let y = 0; y < height; y += 30) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        ctx.restore();

        // Render previous turn layers with blur & opacity filter
        ctx.save();
        try {
            ctx.filter = 'blur(10px) opacity(0.3)';
        } catch (e) {}

        Object.keys(previousLayers).forEach(lIdx => {
            const actions = previousLayers[lIdx] || [];
            actions.forEach(act => renderActionOnCtx(ctx, act, rect));
        });
        ctx.restore();

        // Render current player active turn strokes sharp
        arenaGameHistory.forEach(action => {
            renderActionOnCtx(ctx, action, rect);
        });
    }

    function getArenaCoordinates(e) {
        if (!arenaCanvas) return { x: 0, y: 0 };
        const rect = arenaCanvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;

        return {
            x: (clientX - rect.left) / rect.width,
            y: (clientY - rect.top) / rect.height
        };
    }

    function handleArenaPointerDown(e) {
        if (!isMyTurn) {
            showToast('🎭 Wait for your turn to draw!');
            return;
        }
        const coords = getArenaCoordinates(e);
        arenaIsDrawing = true;
        arenaStartX = coords.x;
        arenaStartY = coords.y;
        arenaCurrentPoints = [{ x: coords.x, y: coords.y }];
    }

    function handleArenaPointerMove(e) {
        if (!arenaIsDrawing) return;
        const coords = getArenaCoordinates(e);
        arenaCurrentPoints.push({ x: coords.x, y: coords.y });
        redrawArenaCanvas();

        if (arenaCanvas) {
            const ctx = arenaCanvas.getContext('2d');
            const rect = arenaCanvas.parentElement.getBoundingClientRect();
            renderActionOnCtx(ctx, {
                tool: arenaTool,
                color: arenaColor,
                size: arenaSize,
                points: arenaCurrentPoints,
                startX: arenaStartX,
                startY: arenaStartY,
                endX: coords.x,
                endY: coords.y
            }, rect);
        }
    }

    function handleArenaPointerUp(e) {
        if (!arenaIsDrawing) return;
        arenaIsDrawing = false;

        const coords = getArenaCoordinates(e);
        let action = null;

        if (arenaTool === 'pen' || arenaTool === 'eraser') {
            if (arenaCurrentPoints.length > 0) {
                action = {
                    type: 'game_draw',
                    tool: arenaTool,
                    color: arenaColor,
                    size: arenaSize,
                    points: arenaCurrentPoints
                };
            }
        } else if (arenaTool === 'line' || arenaTool === 'rect' || arenaTool === 'circle') {
            action = {
                type: 'game_draw',
                tool: arenaTool,
                color: arenaColor,
                size: arenaSize,
                startX: arenaStartX,
                startY: arenaStartY,
                endX: coords.x,
                endY: coords.y
            };
        }

        if (action) {
            arenaGameHistory.push(action);
            sendWebSocketMessage(action);
            redrawArenaCanvas();
        }
        arenaCurrentPoints = [];
    }

    if (arenaCanvas) {
        arenaCanvas.addEventListener('mousedown', handleArenaPointerDown);
        arenaCanvas.addEventListener('mousemove', handleArenaPointerMove);
        arenaCanvas.addEventListener('mouseup', handleArenaPointerUp);
        arenaCanvas.addEventListener('mouseleave', handleArenaPointerUp);

        arenaCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); handleArenaPointerDown(e); });
        arenaCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); handleArenaPointerMove(e); });
        arenaCanvas.addEventListener('touchend', (e) => { e.preventDefault(); handleArenaPointerUp(e); });
    }

    if (arenaColorPicker) {
        arenaColorPicker.addEventListener('change', (e) => {
            arenaColor = e.target.value;
        });
    }

    if (arenaUndoBtn) {
        arenaUndoBtn.addEventListener('click', () => {
            if (arenaGameHistory.length > 0) {
                arenaGameHistory.pop();
                redrawArenaCanvas();
                sendWebSocketMessage({ type: 'game_undo' });
            }
        });
    }

    if (arenaClearBtn) {
        arenaClearBtn.addEventListener('click', () => {
            arenaGameHistory = [];
            redrawArenaCanvas();
            sendWebSocketMessage({ type: 'game_clear' });
        });
    }

    const arenaToolBtns = document.querySelectorAll('.arena-tool-btn');
    arenaToolBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            arenaToolBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            arenaTool = btn.dataset.tool || 'pen';
        });
    });

    // ==========================================================================
    // WebSocket Client Integration & Auto-Reconnection
    // ==========================================================================
    function connectWebSocket() {
        if (!userName) {
            userName = localStorage.getItem('collabdraw_username') || `User#${Math.floor(1000 + Math.random() * 9000)}`;
            localStorage.setItem('collabdraw_username', userName);
        }

        if (reconnectTimeout) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = null;
        }

        if (socket) {
            socket.onclose = null;
            socket.onerror = null;
            socket.close();
        }

        updateConnectionStatus('connecting', 'Connecting...');

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let host = window.location.host;

        // Fallback for direct static file opening (file://)
        if (!host || window.location.protocol === 'file:') {
            host = 'localhost:8000';
        }

        const wsUrl = `${protocol}//${host}/ws/${encodeURIComponent(roomId)}?client_id=${clientId}&name=${encodeURIComponent(userName)}&color=${encodeURIComponent(userColor)}`;

        socket = new WebSocket(wsUrl);

        socket.onopen = function () {
            isConnected = true;
            reconnectAttempts = 0;
            updateConnectionStatus('connected', 'Connected');
            showToast(`Joined room: ${roomId}`);
        };

        socket.onmessage = function (event) {
            try {
                const message = JSON.parse(event.data);
                handleServerMessage(message);
            } catch (err) {
                console.error('Error parsing WebSocket message:', err);
            }
        };

        socket.onclose = function (event) {
            isConnected = false;
            updateConnectionStatus('disconnected', 'Disconnected');
            clearRemoteCursors();

            if (event && (event.code === 4001 || event.reason === "Session already in progress")) {
                showSessionInProgressAlert(roomId);
                return;
            }

            // Auto-reconnect logic
            if (reconnectAttempts < maxReconnectAttempts) {
                reconnectAttempts++;
                const delay = Math.min(5000, 1000 * Math.pow(1.5, reconnectAttempts));
                updateConnectionStatus('connecting', `Reconnecting (${reconnectAttempts})...`);
                
                reconnectTimeout = setTimeout(() => {
                    connectWebSocket();
                }, delay);
            }
        };

        socket.onerror = function (error) {
            console.error('WebSocket Error:', error);
        };
    }

    function sendWebSocketMessage(data) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(data));
        }
    }

    // Throttled cursor transmitter
    let lastCursorSend = 0;
    function sendCursorPosition(x, y) {
        const now = Date.now();
        if (now - lastCursorSend > 35) { // ~30 FPS throttle
            lastCursorSend = now;
            sendWebSocketMessage({
                type: 'cursor',
                x: x,
                y: y,
                name: userName,
                color: userColor
            });
        }
    }

    function hideAllModals() {
        const modalIds = [
            'sessionInProgressModal',
            'landingModal',
            'lobbyModal',
            'presenceModal',
            'aiDiagramModal',
            'gameStageModal',
            'revealModal',
            'votingModal',
            'ceremonyModal'
        ];
        modalIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.classList.add('hidden');
                el.style.display = 'none';
            }
        });
    }

    function showSessionInProgressAlert(code) {
        if (socket) {
            socket.onclose = null;
            socket.close();
        }
        setURLRoomParam('');
        hideAllModals();

        const display = document.getElementById('inProgressRoomCodeDisplay');
        if (display) display.textContent = code || roomId || '-';

        const alertModal = document.getElementById('sessionInProgressModal');
        if (alertModal) {
            alertModal.classList.remove('hidden');
            alertModal.style.display = 'flex';
        }
        showToast('🔒 Session In Progress: Room session already launched!');
    }

    function handleServerMessage(msg) {
        switch (msg.type) {
            case 'init':
                canvasHistory = msg.history || [];
                activeUsers = msg.users || [];
                if (msg.role === 'Host' || msg.is_host) {
                    isHost = true;
                    sessionStorage.setItem('collabdraw_host_' + roomId, 'true');
                } else {
                    isHost = false;
                    sessionStorage.removeItem('collabdraw_host_' + roomId);
                }
                updateUserStack();
                updateLobbyView();
                // Filter and restore sticky notes from history
                canvasHistory.forEach(act => {
                    if (act.type === 'sticky_create' || act.type === 'sticky_update') {
                        createStickyNote(act, false);
                    } else if (act.type === 'sticky_delete') {
                        deleteStickyNoteDOM(act.note_id);
                    }
                });
                redrawFullCanvas();
                break;

            case 'user_joined':
                activeUsers = msg.users || [];
                updateUserStack();
                updateLobbyView();
                showToast(`${msg.name} joined the room`);
                break;

            case 'user_left':
                activeUsers = msg.users || [];
                removeRemoteCursor(msg.client_id);
                updateUserStack();
                updateLobbyView();
                showToast(`${msg.name} left the room`);
                break;

            case 'start_session':
                hideAllModals();
                if (msg.mode === 'game') {
                    showToast('🎮 Party Game Session Launched!');
                } else {
                    redrawFullCanvas();
                    showToast('🎨 Session Launched! Collaborative Whiteboard Canvas active.');
                }
                break;

            case 'session_in_progress':
                showSessionInProgressAlert(msg.room_id || roomId);
                break;

            case 'request_next_round':
                const isHostUser = Boolean(isHost || (sessionStorage.getItem('collabdraw_host_' + roomId) === 'true'));
                const reqKind = msg.request_kind || 'next_round';
                const msgText = (reqKind === 'voting')
                    ? `🏆 ${msg.name} requested you to start Voting!`
                    : `🚀 ${msg.name} requested you to start Next Round!`;

                showToast(msgText);

                if (isHostUser) {
                    if (reqKind === 'voting') {
                        const proceedBtn = document.getElementById('proceedToVotingBtn');
                        if (proceedBtn) {
                            proceedBtn.style.boxShadow = '0 0 20px #f59e0b';
                            proceedBtn.innerHTML = `<span>Proceed to Voting 🏆 (Requested by ${msg.name})</span>`;
                        }
                    } else {
                        const playAgainBtn = document.getElementById('ceremonyPlayAgainBtn');
                        if (playAgainBtn) {
                            playAgainBtn.style.boxShadow = '0 0 20px #ec4899';
                            playAgainBtn.innerHTML = `<span>Play Next Round 🔄 (Requested by ${msg.name})</span>`;
                        }
                    }
                }
                break;

            case 'permissions_updated':
                isDrawingLocked = msg.drawing_locked || false;
                activeUsers = msg.users || activeUsers;
                updateUserStack();
                updateLobbyView();
                updateLockDrawingUI();
                showToast(isDrawingLocked ? '🔒 Drawing permissions locked by Host' : '🔓 Drawing permissions unlocked by Host');
                break;

            case 'role_changed':
                activeUsers = msg.users || activeUsers;
                if (msg.host_client_id === clientId) {
                    isHost = true;
                    sessionStorage.setItem('collabdraw_host_' + roomId, 'true');
                    showToast('👑 You are now the Room Host!');
                }
                updateUserStack();
                updateLobbyView();
                break;

            case 'lobby_settings_updated':
                if (msg.turn_timer) selectedLobbyTimer = msg.turn_timer;
                if (msg.visibility_mode) selectedLobbyVisibility = msg.visibility_mode;
                updateLobbyPillUI();
                showToast(`⚙️ Lobby Settings Updated: ${selectedLobbyTimer}s, ${selectedLobbyVisibility.toUpperCase()}`);
                break;

            case 'draw':
                canvasHistory.push(msg);
                redrawFullCanvas();
                break;

            case 'cursor':
                updateRemoteCursor(msg.client_id, msg.x, msg.y, msg.name, msg.color);
                break;

            case 'clear':
                canvasHistory = [];
                stickyNotesMap.forEach(v => v.el.remove());
                stickyNotesMap.clear();
                redrawFullCanvas();
                showToast('Canvas cleared by room participant');
                break;

            case 'chat':
                appendChatMessage(msg);
                break;

            case 'sticky_create':
            case 'sticky_update':
                createStickyNote(msg, false);
                break;

            case 'sticky_delete':
                deleteStickyNoteDOM(msg.note_id);
                break;

            case 'voice_status':
                updateVoiceSpeakingState(msg.client_id, msg.is_speaking);
                break;

            case 'ai_diagram':
                if (msg.shapes) {
                    msg.shapes.forEach(shape => canvasHistory.push(shape));
                    redrawFullCanvas();
                    showToast('✨ AI Diagram generated!');
                }
                break;

            case 'game_created':
                isGameMode = true;
                isHost = msg.is_host;
                roomId = msg.room_code;
                sessionStorage.setItem('collabdraw_host_' + roomId, 'true');
                if (roomInput) roomInput.value = roomId;
                if (currentRoomCodeDisplay) currentRoomCodeDisplay.textContent = roomId;
                setURLRoomParam(roomId);
                connectWebSocket();
                showLobbyView(roomId);
                showToast(`🎮 Game Room Created: ${roomId}`);
                break;

            case 'turn_start':
                isGameMode = true;
                gameStatus = 'playing';
                previousLayers = msg.previous_layers || {};
                activeGameTurn = msg.turn_index;
                isMyTurn = (msg.active_player && msg.active_player.client_id === clientId);
                arenaGameHistory = []; // Reset active turn strokes for arena

                const lModal = document.getElementById('lobbyModal');
                if (lModal) {
                    lModal.classList.add('hidden');
                    lModal.style.display = 'none';
                }

                const rModal = document.getElementById('revealModal');
                if (rModal) {
                    rModal.classList.add('hidden');
                    rModal.style.display = 'none';
                }

                const stageModal = document.getElementById('gameStageModal');
                const promptEl = document.getElementById('arenaPromptText');
                const turnEl = document.getElementById('arenaTurnDisplay');
                const timerEl = document.getElementById('arenaTimerDisplay');
                const finishBtn = document.getElementById('arenaFinishTurnBtn');

                if (stageModal) {
                    if (isMyTurn) {
                        stageModal.classList.remove('hidden');
                        stageModal.style.cssText = "position: fixed !important; top: 0 !important; left: 0 !important; width: 100vw !important; height: 100vh !important; z-index: 99999 !important; background: rgba(15, 23, 42, 0.95); backdrop-filter: blur(16px); display: flex !important; align-items: center; justify-content: center;";
                        setTimeout(resizeArenaCanvas, 50);
                    } else {
                        stageModal.classList.add('hidden');
                        stageModal.style.display = 'none';
                    }

                    if (promptEl) {
                        promptEl.textContent = isMyTurn ? `Prompt: "${msg.prompt}"` : `🎭 Hidden Prompt (${msg.active_player ? msg.active_player.name : 'Player'} is drawing...)`;
                    }
                    if (turnEl) {
                        turnEl.textContent = `${msg.active_player ? msg.active_player.name : 'Player'} (${msg.turn_index + 1}/${msg.total_turns})`;
                    }
                    if (timerEl) {
                        timerEl.textContent = `⏱️ 00:${String(msg.time_left).padStart(2, '0')}`;
                    }
                    if (finishBtn) {
                        finishBtn.style.display = isMyTurn ? 'flex' : 'none';
                        finishBtn.disabled = !isMyTurn;
                    }
                }

                if (isMyTurn) {
                    showToast(`🎨 YOUR TURN! Prompt: "${msg.prompt}"`);
                } else {
                    showToast(`Turn ${msg.turn_index + 1}: ${msg.active_player ? msg.active_player.name : 'Player'} is drawing...`);
                }
                redrawArenaCanvas();
                break;

            case 'game_draw':
                if (!isMyTurn) {
                    arenaGameHistory.push(msg.data || msg);
                    redrawArenaCanvas();
                }
                break;

            case 'game_undo':
                if (!isMyTurn) {
                    arenaGameHistory.pop();
                    redrawArenaCanvas();
                }
                break;

            case 'game_clear':
                if (!isMyTurn) {
                    arenaGameHistory = [];
                    redrawArenaCanvas();
                }
                break;

            case 'timer_tick':
                const tEl = document.getElementById('gameTimerDisplay');
                const aTimerEl = document.getElementById('arenaTimerDisplay');
                if (tEl) {
                    tEl.textContent = `00:${String(msg.time_left).padStart(2, '0')}`;
                }
                if (aTimerEl) {
                    aTimerEl.textContent = `⏱️ 00:${String(msg.time_left).padStart(2, '0')}`;
                }
                break;

            case 'game_reveal':
                gameStatus = 'reveal';
                const sModal = document.getElementById('gameStageModal');
                const hHud = document.getElementById('gameHudBar');
                if (sModal) {
                    sModal.classList.add('hidden');
                    sModal.style.display = 'none';
                }
                if (hHud) {
                    hHud.classList.add('hidden');
                    hHud.style.display = 'none';
                }
                showFinalRevealModal(msg);
                break;

            case 'voting_start':
                gameStatus = 'voting';
                if (revealModal) {
                    revealModal.classList.add('hidden');
                    revealModal.style.display = 'none';
                }
                showVotingModal(msg);
                break;

            case 'voting_timer_tick':
                const vTimerEl = document.getElementById('votingTimerDisplay');
                if (vTimerEl) {
                    vTimerEl.textContent = `⏱️ 00:${String(msg.time_left).padStart(2, '0')}`;
                }
                break;

            case 'vote_progress':
                const vProgEl = document.getElementById('voteProgressText');
                if (vProgEl) {
                    vProgEl.textContent = `${msg.voted_count} of ${msg.total_players} votes submitted...`;
                }
                break;

            case 'voting_results':
                gameStatus = 'ceremony';
                const vModal = document.getElementById('votingModal');
                if (vModal) {
                    vModal.classList.add('hidden');
                    vModal.style.display = 'none';
                }
                showCeremonyModal(msg);
                break;

            case 'sync_history':
                canvasHistory = msg.history || [];
                redrawFullCanvas();
                break;
        }
    }

    // ==========================================================================
    // Remote Peer Cursor Layer Management
    // ==========================================================================
    function updateRemoteCursor(cid, relX, relY, name, color) {
        const rect = canvas.getBoundingClientRect();
        const posX = relX * rect.width;
        const posY = relY * rect.height;

        let cursorEl = remoteCursors.get(cid);

        if (!cursorEl) {
            cursorEl = document.createElement('div');
            cursorEl.className = 'remote-cursor';
            cursorEl.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none">
                    <path d="M5.65376 12.3673H5.46026L5.31717 12.4976L0.500002 16.8829L0.500002 1.19841L17.7841 12.3673H5.65376Z" fill="${color}" stroke="#ffffff" stroke-width="1.2"/>
                </svg>
                <div class="remote-cursor-label" style="background-color: ${color};">${name}</div>
            `;
            cursorOverlay.appendChild(cursorEl);
            remoteCursors.set(cid, cursorEl);
        }

        cursorEl.style.left = `${posX}px`;
        cursorEl.style.top = `${posY}px`;
    }

    function removeRemoteCursor(cid) {
        const cursorEl = remoteCursors.get(cid);
        if (cursorEl) {
            cursorEl.remove();
            remoteCursors.delete(cid);
        }
    }

    function clearRemoteCursors() {
        remoteCursors.forEach(el => el.remove());
        remoteCursors.clear();
    }

    // ==========================================================================
    // UI Controls & Interaction Event Listeners
    // ==========================================================================
    // ==========================================================================
    // UI Controls & Interaction Event Listeners
    // ==========================================================================
    // Auto-Clean Shapes Button Toggle
    if (autoCleanBtn) {
        autoCleanBtn.addEventListener('click', () => {
            isAutoCleanEnabled = !isAutoCleanEnabled;
            autoCleanBtn.classList.toggle('active', isAutoCleanEnabled);
            showToast(isAutoCleanEnabled ? '🪄 Auto-Clean Shapes Enabled' : 'Auto-Clean Shapes Disabled');
        });
    }

    // Canvas Background Pattern Selector
    if (bgPatternSelect) {
        bgPatternSelect.addEventListener('change', (e) => {
            currentBgPattern = e.target.value;
            redrawFullCanvas();
            showToast(`Background: ${e.target.options[e.target.selectedIndex].text}`);
        });
    }

    // Voice Chat / Spatial Audio Toggle with WebAudio API volume detection
    let localAudioStream = null;
    let audioContext = null;
    let audioAnalyzer = null;
    let audioCheckInterval = null;

    if (voiceChatBtn) {
        voiceChatBtn.addEventListener('click', async () => {
            isVoiceActive = !isVoiceActive;
            voiceChatBtn.classList.toggle('active', isVoiceActive);

            if (isVoiceActive) {
                try {
                    localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    const source = audioContext.createMediaStreamSource(localAudioStream);
                    audioAnalyzer = audioContext.createAnalyser();
                    audioAnalyzer.fftSize = 256;
                    source.connect(audioAnalyzer);

                    const dataArray = new Uint8Array(audioAnalyzer.frequencyBinCount);
                    let lastSpeakingState = false;

                    audioCheckInterval = setInterval(() => {
                        if (!isVoiceActive || !audioAnalyzer) return;
                        audioAnalyzer.getByteFrequencyData(dataArray);
                        let sum = 0;
                        for (let i = 0; i < dataArray.length; i++) {
                            sum += dataArray[i];
                        }
                        const avg = sum / dataArray.length;
                        const isSpeaking = avg > 12;

                        if (isSpeaking !== lastSpeakingState) {
                            lastSpeakingState = isSpeaking;
                            sendWebSocketMessage({
                                type: 'voice_status',
                                is_speaking: isSpeaking
                            });
                            updateVoiceSpeakingState(clientId, isSpeaking);
                        }
                    }, 150);

                    showToast('🎙️ Microphone Unmuted & Voice Streaming Active');
                } catch (err) {
                    console.warn('Microphone access fallback to visual audio indicator:', err);
                    sendWebSocketMessage({
                        type: 'voice_status',
                        is_speaking: true
                    });
                    updateVoiceSpeakingState(clientId, true);
                    showToast('🎙️ Voice Chat Active (Visual Fallback)');
                }
            } else {
                if (audioCheckInterval) clearInterval(audioCheckInterval);
                if (localAudioStream) {
                    localAudioStream.getTracks().forEach(track => track.stop());
                    localAudioStream = null;
                }
                if (audioContext) {
                    audioContext.close();
                    audioContext = null;
                }
                sendWebSocketMessage({
                    type: 'voice_status',
                    is_speaking: false
                });
                updateVoiceSpeakingState(clientId, false);
                showToast('🎙️ Microphone Muted');
            }
        });
    }

    function updateVoiceSpeakingState(cid, isSpeaking) {
        const avatars = avatarStack.querySelectorAll('.user-avatar');
        activeUsers.forEach((u, idx) => {
            if (u.client_id === cid || (cid === clientId && idx === 0)) {
                if (avatars[idx]) {
                    avatars[idx].classList.toggle('speaking', isSpeaking);
                }
            }
        });
    }

    // AI Diagram Generator Modal Controls
    if (aiDiagramBtn) {
        aiDiagramBtn.addEventListener('click', () => {
            aiDiagramModal.classList.remove('hidden');
            aiPromptInput.focus();
        });
    }

    if (closeAiModalBtn) {
        closeAiModalBtn.addEventListener('click', () => {
            aiDiagramModal.classList.add('hidden');
        });
    }

    document.querySelectorAll('.template-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            const template = chip.dataset.template;
            generateAiDiagram(template);
            aiDiagramModal.classList.add('hidden');
        });
    });

    if (aiDiagramForm) {
        aiDiagramForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const prompt = aiPromptInput.value.trim();
            generateAiDiagram(prompt || 'flowchart');
            aiDiagramModal.classList.add('hidden');
            aiPromptInput.value = '';
        });
    }

    function generateAiDiagram(promptOrType) {
        const type = promptOrType.toLowerCase();
        let shapes = [];

        if (type.includes('mind') || type.includes('mindmap')) {
            // Mind Map: Center topic + 4 radial branches
            shapes.push({ type: 'draw', tool: 'circle', color: '#a855f7', size: 4, startX: 0.5, startY: 0.5, endX: 0.56, endY: 0.5 });
            shapes.push({ type: 'draw', tool: 'text', color: '#ffffff', size: 4, x: 0.46, y: 0.51, text: 'Central Topic' });

            const branches = [
                { x: 0.3, y: 0.3, label: 'Idea A' },
                { x: 0.7, y: 0.3, label: 'Idea B' },
                { x: 0.3, y: 0.7, label: 'Idea C' },
                { x: 0.7, y: 0.7, label: 'Idea D' }
            ];

            branches.forEach(b => {
                shapes.push({ type: 'draw', tool: 'line', color: '#38bdf8', size: 2, startX: 0.5, startY: 0.5, endX: b.x, endY: b.y });
                shapes.push({ type: 'draw', tool: 'circle', color: '#38bdf8', size: 3, startX: b.x, startY: b.y, endX: b.x + 0.04, endY: b.y });
                shapes.push({ type: 'draw', tool: 'text', color: '#ffffff', size: 3, x: b.x - 0.02, y: b.y + 0.01, text: b.label });
            });
        } else if (type.includes('arch') || type.includes('system')) {
            // System Architecture: Client -> Nginx Gateway -> Redis
            shapes.push({ type: 'draw', tool: 'rect', color: '#38bdf8', size: 3, startX: 0.15, startY: 0.42, endX: 0.30, endY: 0.58 });
            shapes.push({ type: 'draw', tool: 'text', color: '#ffffff', size: 4, x: 0.18, y: 0.51, text: 'Web Client' });

            shapes.push({ type: 'draw', tool: 'line', color: '#10b981', size: 3, startX: 0.30, startY: 0.50, endX: 0.42, endY: 0.50 });

            shapes.push({ type: 'draw', tool: 'rect', color: '#a855f7', size: 3, startX: 0.42, startY: 0.40, endX: 0.60, endY: 0.60 });
            shapes.push({ type: 'draw', tool: 'text', color: '#ffffff', size: 4, x: 0.45, y: 0.51, text: 'Nginx Gateway' });

            shapes.push({ type: 'draw', tool: 'line', color: '#10b981', size: 3, startX: 0.60, startY: 0.50, endX: 0.72, endY: 0.50 });

            shapes.push({ type: 'draw', tool: 'rect', color: '#f43f5e', size: 3, startX: 0.72, startY: 0.42, endX: 0.88, endY: 0.58 });
            shapes.push({ type: 'draw', tool: 'text', color: '#ffffff', size: 4, x: 0.75, y: 0.51, text: 'Redis Cluster' });
        } else {
            // Flowchart default (3 connected boxes)
            shapes.push({ type: 'draw', tool: 'rect', color: '#10b981', size: 3, startX: 0.20, startY: 0.44, endX: 0.35, endY: 0.56 });
            shapes.push({ type: 'draw', tool: 'text', color: '#ffffff', size: 4, x: 0.25, y: 0.51, text: 'Start' });

            shapes.push({ type: 'draw', tool: 'line', color: '#f59e0b', size: 3, startX: 0.35, startY: 0.50, endX: 0.45, endY: 0.50 });

            shapes.push({ type: 'draw', tool: 'rect', color: '#38bdf8', size: 3, startX: 0.45, startY: 0.42, endX: 0.62, endY: 0.58 });
            shapes.push({ type: 'draw', tool: 'text', color: '#ffffff', size: 4, x: 0.47, y: 0.51, text: 'Process Data' });

            shapes.push({ type: 'draw', tool: 'line', color: '#f59e0b', size: 3, startX: 0.62, startY: 0.50, endX: 0.72, endY: 0.50 });

            shapes.push({ type: 'draw', tool: 'rect', color: '#ec4899', size: 3, startX: 0.72, startY: 0.44, endX: 0.85, endY: 0.56 });
            shapes.push({ type: 'draw', tool: 'text', color: '#ffffff', size: 4, x: 0.76, y: 0.51, text: 'Done' });
        }

        // Local record & render
        shapes.forEach(s => canvasHistory.push(s));
        redrawFullCanvas();

        // Broadcast via WebSocket
        sendWebSocketMessage({
            type: 'ai_diagram',
            shapes: shapes
        });

        showToast('✨ AI Diagram generated!');
    }

    // Tool Selection
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentTool = btn.dataset.tool;
        });
    });

    // Color Swatches
    document.querySelectorAll('.color-swatch').forEach(swatch => {
        swatch.addEventListener('click', () => {
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
            swatch.classList.add('active');
            strokeColor = swatch.dataset.color;
            customColorPicker.value = strokeColor;
        });
    });

    if (customColorPicker) {
        customColorPicker.addEventListener('input', (e) => {
            strokeColor = e.target.value;
            document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
        });
    }

    // Stroke Size Slider
    if (sizeSlider) {
        sizeSlider.addEventListener('input', (e) => {
            strokeSize = parseInt(e.target.value, 10);
            if (sizeValueDisplay) sizeValueDisplay.textContent = `${strokeSize}px`;
        });
    }

    // Actions
    if (undoBtn) {
        undoBtn.addEventListener('click', () => {
            sendWebSocketMessage({ type: 'undo' });
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the canvas for everyone in this room?')) {
                sendWebSocketMessage({ type: 'clear' });
            }
        });
    }

    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const link = document.createElement('a');
            link.download = `collabdraw-${roomId}-${Date.now()}.png`;
            link.href = canvas.toDataURL('image/png');
            link.click();
            showToast('Canvas exported as PNG');
        });
    }

    if (exportSvgBtn) {
        exportSvgBtn.addEventListener('click', exportCanvasToSVG);
    }

    if (exportPdfBtn) {
        exportPdfBtn.addEventListener('click', exportCanvasToPDF);
    }

    function exportCanvasToSVG() {
        const rect = canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        let svgElements = [];
        const bgFill = currentBgPattern === 'light' ? '#f8fafc' : '#0f172a';
        svgElements.push(`<rect width="${width}" height="${height}" fill="${bgFill}"/>`);

        canvasHistory.forEach(action => {
            if (action.tool === 'pen' || action.tool === 'eraser') {
                if (action.points && action.points.length > 0) {
                    const strokeColor = action.tool === 'eraser' ? bgFill : (action.color || '#ffffff');
                    const pathData = action.points.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x * width} ${p.y * height}`).join(' ');
                    svgElements.push(`<path d="${pathData}" stroke="${strokeColor}" stroke-width="${action.size || 2}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`);
                }
            } else if (action.tool === 'line') {
                svgElements.push(`<line x1="${action.startX * width}" y1="${action.startY * height}" x2="${action.endX * width}" y2="${action.endY * height}" stroke="${action.color || '#ffffff'}" stroke-width="${action.size || 2}" stroke-linecap="round"/>`);
            } else if (action.tool === 'rect') {
                const x = action.startX * width;
                const y = action.startY * height;
                const w = (action.endX - action.startX) * width;
                const h = (action.endY - action.startY) * height;
                svgElements.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" stroke="${action.color || '#ffffff'}" stroke-width="${action.size || 2}" fill="none"/>`);
            } else if (action.tool === 'circle') {
                const sx = action.startX * width;
                const sy = action.startY * height;
                const ex = action.endX * width;
                const ey = action.endY * height;
                const radius = Math.sqrt(Math.pow(ex - sx, 2) + Math.pow(ey - sy, 2));
                svgElements.push(`<circle cx="${sx}" cy="${sy}" r="${radius}" stroke="${action.color || '#ffffff'}" stroke-width="${action.size || 2}" fill="none"/>`);
            } else if (action.tool === 'text') {
                svgElements.push(`<text x="${action.x * width}" y="${action.y * height}" fill="${action.color || '#ffffff'}" font-family="Outfit, sans-serif" font-size="${(action.size || 4) * 3 + 10}">${action.text}</text>`);
            }
        });

        // Include Sticky Notes in SVG export
        stickyNotesMap.forEach(note => {
            const d = note.data;
            const nx = (d.x || 0.4) * width;
            const ny = (d.y || 0.4) * height;
            svgElements.push(`<g transform="translate(${nx}, ${ny})">
                <rect width="170" height="150" rx="8" fill="${d.color || '#fef08a'}" filter="drop-shadow(0 4px 6px rgba(0,0,0,0.3))"/>
                <text x="12" y="30" fill="#1e293b" font-family="Outfit, sans-serif" font-size="13" font-weight="500">${d.text || ''}</text>
            </g>`);
        });

        const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        ${svgElements.join('\n')}
        </svg>`;

        const blob = new Blob([svgContent], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `collabdraw-${roomId}-${Date.now()}.svg`;
        link.click();
        URL.revokeObjectURL(url);
        showToast('Canvas exported as vector SVG!');
    }

    function exportCanvasToPDF() {
        const rect = canvas.getBoundingClientRect();
        const width = rect.width;
        const height = rect.height;

        // High-DPI Canvas Snapshot Data
        const imgData = canvas.toDataURL('image/png', 1.0);

        try {
            if (window.jspdf && window.jspdf.jsPDF) {
                const { jsPDF } = window.jspdf;
                const orientation = width >= height ? 'landscape' : 'portrait';
                const pdf = new jsPDF({
                    orientation: orientation,
                    unit: 'px',
                    format: [width, height]
                });

                pdf.addImage(imgData, 'PNG', 0, 0, width, height);

                // Draw sticky notes overlay onto PDF document
                stickyNotesMap.forEach(note => {
                    const d = note.data;
                    const nx = (d.x || 0.4) * width;
                    const ny = (d.y || 0.4) * height;

                    pdf.setFillColor(d.color || '#fef08a');
                    pdf.roundedRect(nx, ny, 170, 150, 6, 6, 'F');

                    pdf.setTextColor(30, 41, 59);
                    pdf.setFontSize(11);
                    const splitText = pdf.splitTextToSize(d.text || '', 150);
                    pdf.text(splitText, nx + 10, ny + 25);
                });

                pdf.save(`collabdraw-${roomId}-${Date.now()}.pdf`);
                showToast('Canvas exported as PDF Document!');
            } else {
                // Fallback to print stream / image PDF print
                const win = window.open('', '_blank');
                win.document.write(`
                    <html>
                        <head><title>CollabDraw PDF Export - ${roomId}</title></head>
                        <body style="margin:0; background:#0f172a; display:flex; justify-content:center; align-items:center;">
                            <img src="${imgData}" style="max-width:100%; height:auto;" />
                            <script>window.onload = function() { window.print(); window.close(); };</script>
                        </body>
                    </html>
                `);
                win.document.close();
                showToast('PDF Print Stream Triggered');
            }
        } catch (err) {
            console.error('Error generating PDF:', err);
            showToast('PDF Export Error - Check Console');
        }
    }

    // Room Switcher (legacy fallback guard)
    if (joinRoomBtn) {
        joinRoomBtn.addEventListener('click', switchRoom);
    }
    if (roomInput) {
        roomInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') switchRoom();
        });
    }

    // ==========================================================================
    // Blind Chain Draw Game Event Listeners & Reveal Controls
    // ==========================================================================
    if (createGameBtn) {
        createGameBtn.addEventListener('click', () => {
            sendWebSocketMessage({ type: 'create_game' });
        });
    }

    if (startGameBtn) {
        startGameBtn.addEventListener('click', (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            showToast('🚀 Starting Game...');
            sendWebSocketMessage({ type: 'start_game' });
        });
    }

    const handleFinishTurn = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        showToast('✅ Turn Submitted!');
        const sModal = document.getElementById('gameStageModal');
        if (sModal) {
            sModal.classList.add('hidden');
            sModal.style.display = 'none';
        }
        sendWebSocketMessage({ type: 'finish_turn' });
    };

    if (finishTurnBtn) finishTurnBtn.addEventListener('click', handleFinishTurn);
    if (arenaFinishTurnBtn) arenaFinishTurnBtn.addEventListener('click', handleFinishTurn);

    if (playAgainBtn) {
        playAgainBtn.addEventListener('click', (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            const rModal = document.getElementById('revealModal');
            if (rModal) {
                rModal.classList.add('hidden');
                rModal.style.display = 'none';
            }
            showToast('🚀 Starting Next Round...');
            sendWebSocketMessage({ type: 'start_game' });
        });
    }

    const closeRevealAction = () => {
        if (revealModal) revealModal.classList.add('hidden');
        if (gameStageModal) gameStageModal.classList.add('hidden');
        showToast('🎨 Returned to Whiteboard Canvas');
    };

    if (closeRevealModalBtn) closeRevealModalBtn.addEventListener('click', closeRevealAction);
    if (quitRevealBtn) quitRevealBtn.addEventListener('click', closeRevealAction);

    function showFinalRevealModal(data) {
        if (!revealModal) return;

        if (window.revealVotingTimer) {
            clearTimeout(window.revealVotingTimer);
            window.revealVotingTimer = null;
        }

        // Strictly check host status for THIS tab/session
        const hostBySession = (sessionStorage.getItem('collabdraw_host_' + roomId) === 'true');
        const hostBySessionObj = (data.game_session && data.game_session.host_client_id === clientId);
        const isHostUser = Boolean(isHost || hostBySession || hostBySessionObj);

        const proceedBtn = document.getElementById('proceedToVotingBtn');
        const reqRevealBtn = document.getElementById('requestNextRoundRevealBtn');

        if (proceedBtn) proceedBtn.style.display = isHostUser ? 'inline-flex' : 'none';
        if (reqRevealBtn) reqRevealBtn.style.display = isHostUser ? 'none' : 'inline-flex';
        if (quitRevealBtn) quitRevealBtn.style.display = 'inline-flex';

        revealPromptText.textContent = `Prompt: "${data.prompt}"`;
        
        // Populate contributor badges
        revealContributors.innerHTML = '';
        (data.players || []).forEach((p, idx) => {
            const badge = document.createElement('div');
            badge.className = 'contributor-badge';
            badge.style.color = p.color || '#38bdf8';
            badge.textContent = `Layer ${idx + 1}: ${p.name}`;
            revealContributors.appendChild(badge);
        });

        // 1. Unhide modal FIRST so CSS dimensions (clientWidth/clientHeight) are non-zero!
        revealModal.classList.remove('hidden');
        revealModal.style.display = 'flex';

        // 2. Render merged layers on revealCanvas
        const rCanvas = document.getElementById('revealCanvas');
        if (rCanvas) {
            const wrapper = rCanvas.parentElement;
            const parentWidth = (wrapper && wrapper.clientWidth > 0) ? wrapper.clientWidth : 620;
            const parentHeight = (wrapper && wrapper.clientHeight > 0) ? wrapper.clientHeight : 340;
            const dpr = window.devicePixelRatio || 1;

            rCanvas.width = parentWidth * dpr;
            rCanvas.height = parentHeight * dpr;

            const rCtx = rCanvas.getContext('2d');
            rCtx.save();
            rCtx.scale(dpr, dpr);

            // Dark canvas background fill
            rCtx.fillStyle = '#0f172a';
            rCtx.fillRect(0, 0, parentWidth, parentHeight);

            // Grid pattern
            rCtx.strokeStyle = '#1e293b';
            rCtx.lineWidth = 1;
            for (let x = 0; x < parentWidth; x += 30) {
                rCtx.beginPath();
                rCtx.moveTo(x, 0);
                rCtx.lineTo(x, parentHeight);
                rCtx.stroke();
            }
            for (let y = 0; y < parentHeight; y += 30) {
                rCtx.beginPath();
                rCtx.moveTo(0, y);
                rCtx.lineTo(parentWidth, y);
                rCtx.stroke();
            }

            const allLayers = data.all_layers || {};
            const rect = { width: parentWidth, height: parentHeight };

            Object.keys(allLayers).sort((a, b) => parseInt(a) - parseInt(b)).forEach(lIdx => {
                const actions = allLayers[lIdx] || [];
                actions.forEach(action => {
                    renderActionOnCtx(rCtx, action, rect);
                });
            });
            rCtx.restore();
        }
    }

    // Voting Phase state variables & elements
    let selectedBestCreative = null;
    let selectedMostChaotic = null;
    let currentVotingPlayers = [];

    const proceedToVotingBtn = document.getElementById('proceedToVotingBtn');
    const votingModal = document.getElementById('votingModal');
    const bestCreativeGrid = document.getElementById('bestCreativeGrid');
    const mostChaoticGrid = document.getElementById('mostChaoticGrid');
    const submitVotesBtn = document.getElementById('submitVotesBtn');
    const voteProgressText = document.getElementById('voteProgressText');

    if (proceedToVotingBtn) {
        proceedToVotingBtn.addEventListener('click', (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            showToast('🏆 Starting Voting Phase...');
            sendWebSocketMessage({ type: 'start_voting' });
        });
    }

    function showVotingModal(data) {
        if (!votingModal) return;
        selectedBestCreative = null;
        selectedMostChaotic = null;
        if (submitVotesBtn) submitVotesBtn.disabled = true;

        currentVotingPlayers = data.players || [];
        if (voteProgressText) {
            voteProgressText.textContent = `0 of ${currentVotingPlayers.length} votes submitted...`;
        }

        renderVoterGrid(bestCreativeGrid, currentVotingPlayers, 'creative');
        renderVoterGrid(mostChaoticGrid, currentVotingPlayers, 'chaotic');

        votingModal.classList.remove('hidden');
        votingModal.style.display = 'flex';
    }

    function renderVoterGrid(gridEl, players, category) {
        if (!gridEl) return;
        gridEl.innerHTML = '';

        players.forEach(p => {
            const card = document.createElement('div');
            card.className = 'voter-card';
            card.dataset.cid = p.client_id;
            
            const isSelf = (p.client_id === clientId);

            card.innerHTML = `
                <div class="voter-avatar" style="background-color: ${p.color || '#38bdf8'};">
                    ${p.name.charAt(0).toUpperCase()}
                </div>
                <div class="voter-name">${p.name}</div>
                ${isSelf ? '<div class="voter-badge-disabled">Self (No Vote)</div>' : ''}
            `;

            if (isSelf) {
                card.classList.add('disabled');
            } else {
                card.addEventListener('click', () => {
                    if (category === 'creative') {
                        selectedBestCreative = p.client_id;
                        highlightVoterSelection(bestCreativeGrid, p.client_id);
                    } else {
                        selectedMostChaotic = p.client_id;
                        highlightVoterSelection(mostChaoticGrid, p.client_id);
                    }
                    checkSubmitVoteState();
                });
            }
            gridEl.appendChild(card);
        });
    }

    function highlightVoterSelection(gridEl, selectedCid) {
        if (!gridEl) return;
        const cards = gridEl.querySelectorAll('.voter-card');
        cards.forEach(c => {
            if (c.dataset.cid === selectedCid) {
                c.classList.add('selected');
            } else {
                c.classList.remove('selected');
            }
        });
    }

    function checkSubmitVoteState() {
        if (submitVotesBtn) {
            submitVotesBtn.disabled = !(selectedBestCreative && selectedMostChaotic);
        }
    }

    if (submitVotesBtn) {
        submitVotesBtn.addEventListener('click', (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (!selectedBestCreative || !selectedMostChaotic) return;
            submitVotesBtn.disabled = true;
            showToast('🗳️ Votes Submitted!');
            sendWebSocketMessage({
                type: 'submit_vote',
                best_creative: selectedBestCreative,
                most_chaotic: selectedMostChaotic
            });
        });
    }

    // Award Ceremony Screen elements & logic
    const ceremonyModal = document.getElementById('ceremonyModal');
    const ceremonyPromptText = document.getElementById('ceremonyPromptText');
    const ceremonyWinnerCards = document.getElementById('ceremonyWinnerCards');
    const ceremonyCanvas = document.getElementById('ceremonyCanvas');
    const ceremonyAwardBadges = document.getElementById('ceremonyAwardBadges');
    const ceremonyPlayAgainBtn = document.getElementById('ceremonyPlayAgainBtn');
    const ceremonyQuitBtn = document.getElementById('ceremonyQuitBtn');
    const closeCeremonyBtn = document.getElementById('closeCeremonyBtn');

    function returnToLobbyFromGame() {
        if (window.revealVotingTimer) clearTimeout(window.revealVotingTimer);
        hideAllModals();
        if (sessionStorage.getItem('collabdraw_host_' + roomId) === 'true') {
            isHost = true;
        }
        showLobbyView(roomId);
        showToast('🏰 Returned to Room Lobby');
    }

    function sendVotingRequest() {
        sendWebSocketMessage({
            type: 'request_next_round',
            name: userName,
            request_kind: 'voting'
        });
        showToast('📩 Request sent to Host to start Voting!');
    }

    function sendNextRoundRequest() {
        sendWebSocketMessage({
            type: 'request_next_round',
            name: userName,
            request_kind: 'next_round'
        });
        showToast('📩 Request sent to Host for Next Round!');
    }

    const requestNextRoundRevealBtn = document.getElementById('requestNextRoundRevealBtn');
    const requestNextRoundCeremonyBtn = document.getElementById('requestNextRoundCeremonyBtn');

    if (requestNextRoundRevealBtn) requestNextRoundRevealBtn.addEventListener('click', sendVotingRequest);
    if (requestNextRoundCeremonyBtn) requestNextRoundCeremonyBtn.addEventListener('click', sendNextRoundRequest);

    if (quitRevealBtn) quitRevealBtn.addEventListener('click', returnToLobbyFromGame);
    if (closeCeremonyBtn) closeCeremonyBtn.addEventListener('click', returnToLobbyFromGame);
    if (ceremonyQuitBtn) ceremonyQuitBtn.addEventListener('click', returnToLobbyFromGame);

    if (ceremonyPlayAgainBtn) {
        ceremonyPlayAgainBtn.addEventListener('click', (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (ceremonyModal) {
                ceremonyModal.classList.add('hidden');
                ceremonyModal.style.display = 'none';
            }
            showToast('🚀 Starting Next Round...');
            sendWebSocketMessage({ type: 'start_game' });
        });
    }

    function showCeremonyModal(data) {
        if (!ceremonyModal) return;

        const hostBySession = (sessionStorage.getItem('collabdraw_host_' + roomId) === 'true');
        const hostBySessionObj = (data.game_session && data.game_session.host_client_id === clientId);
        const isHostUser = Boolean(isHost || hostBySession || hostBySessionObj);

        if (ceremonyPlayAgainBtn) {
            ceremonyPlayAgainBtn.style.display = isHostUser ? 'inline-flex' : 'none';
        }
        const reqCeremonyBtn = document.getElementById('requestNextRoundCeremonyBtn');
        if (reqCeremonyBtn) {
            reqCeremonyBtn.style.display = isHostUser ? 'none' : 'inline-flex';
        }

        if (ceremonyPromptText) {
            ceremonyPromptText.textContent = `Prompt: "${data.prompt}"`;
        }

        // Render winner cards
        if (ceremonyWinnerCards) {
            ceremonyWinnerCards.innerHTML = '';
            const winners = data.winners || {};

            const creativeWin = winners.best_creative || {};
            const chaoticWin = winners.most_chaotic || {};

            const createCard = (title, icon, winData) => {
                const p = winData.player || { name: 'Nobody', color: '#38bdf8' };
                const card = document.createElement('div');
                card.className = 'winner-trophy-card';
                card.innerHTML = `
                    <div class="winner-category-tag">${icon} ${title}</div>
                    <div class="voter-avatar" style="background-color: ${p.color || '#38bdf8'}; width: 44px; height: 44px; font-size: 18px;">
                        ${(p.name || 'P').charAt(0).toUpperCase()}
                    </div>
                    <div class="winner-name-display">${p.name || 'Player'}</div>
                    <div class="winner-votes-count">${winData.votes || 0} Votes</div>
                `;
                return card;
            };

            ceremonyWinnerCards.appendChild(createCard('Most Creative', '🎨', creativeWin));
            ceremonyWinnerCards.appendChild(createCard('Most Chaotic', '🤡', chaoticWin));
        }

        // Render award pins
        if (ceremonyAwardBadges) {
            ceremonyAwardBadges.innerHTML = '';
            const winners = data.winners || {};
            if (winners.best_creative && winners.best_creative.player) {
                const b = document.createElement('div');
                b.className = 'award-pin-badge';
                b.style.color = '#fbbf24';
                b.innerHTML = `🎨 Most Creative: <strong>${winners.best_creative.player.name}</strong>`;
                ceremonyAwardBadges.appendChild(b);
            }
            if (winners.most_chaotic && winners.most_chaotic.player) {
                const b = document.createElement('div');
                b.className = 'award-pin-badge';
                b.style.color = '#f43f5e';
                b.innerHTML = `🤡 Most Chaotic: <strong>${winners.most_chaotic.player.name}</strong>`;
                ceremonyAwardBadges.appendChild(b);
            }
        }

        // Display modal FIRST to get computed canvas width/height
        ceremonyModal.classList.remove('hidden');
        ceremonyModal.style.display = 'flex';

        // Render merged layers on ceremonyCanvas
        if (ceremonyCanvas) {
            const wrapper = ceremonyCanvas.parentElement;
            const parentWidth = (wrapper && wrapper.clientWidth > 0) ? wrapper.clientWidth : 640;
            const parentHeight = (wrapper && wrapper.clientHeight > 0) ? wrapper.clientHeight : 320;
            const dpr = window.devicePixelRatio || 1;

            ceremonyCanvas.width = parentWidth * dpr;
            ceremonyCanvas.height = parentHeight * dpr;

            const cCtx = ceremonyCanvas.getContext('2d');
            cCtx.save();
            cCtx.scale(dpr, dpr);

            cCtx.fillStyle = '#0f172a';
            cCtx.fillRect(0, 0, parentWidth, parentHeight);

            // Grid pattern
            cCtx.strokeStyle = '#1e293b';
            cCtx.lineWidth = 1;
            for (let x = 0; x < parentWidth; x += 30) {
                cCtx.beginPath();
                cCtx.moveTo(x, 0);
                cCtx.lineTo(x, parentHeight);
                cCtx.stroke();
            }
            for (let y = 0; y < parentHeight; y += 30) {
                cCtx.beginPath();
                cCtx.moveTo(0, y);
                cCtx.lineTo(parentWidth, y);
                cCtx.stroke();
            }

            const allLayers = data.all_layers || {};
            const rect = { width: parentWidth, height: parentHeight };

            Object.keys(allLayers).sort((a, b) => parseInt(a) - parseInt(b)).forEach(lIdx => {
                const actions = allLayers[lIdx] || [];
                actions.forEach(action => {
                    renderActionOnCtx(cCtx, action, rect);
                });
            });
            cCtx.restore();
        }

        // Run particle confetti
        runConfettiAnimation();
    }

    function runConfettiAnimation() {
        const cCanvas = document.getElementById('confettiCanvas');
        if (!cCanvas) return;

        cCanvas.width = window.innerWidth;
        cCanvas.height = window.innerHeight;
        const ctx = cCanvas.getContext('2d');

        const particles = [];
        const colors = ['#f59e0b', '#fbbf24', '#ec4899', '#38bdf8', '#a855f7', '#10b981'];

        for (let i = 0; i < 120; i++) {
            particles.push({
                x: Math.random() * cCanvas.width,
                y: Math.random() * cCanvas.height * 0.5,
                vx: (Math.random() - 0.5) * 6,
                vy: Math.random() * 4 + 2,
                color: colors[Math.floor(Math.random() * colors.length)],
                size: Math.random() * 8 + 4,
                rotation: Math.random() * 360,
                vRot: (Math.random() - 0.5) * 10
            });
        }

        let animationFrame;
        const render = () => {
            ctx.clearRect(0, 0, cCanvas.width, cCanvas.height);
            let activeCount = 0;

            particles.forEach(p => {
                p.x += p.vx;
                p.y += p.vy;
                p.rotation += p.vRot;

                if (p.y < cCanvas.height) {
                    activeCount++;
                    ctx.save();
                    ctx.translate(p.x, p.y);
                    ctx.rotate((p.rotation * Math.PI) / 180);
                    ctx.fillStyle = p.color;
                    ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
                    ctx.restore();
                }
            });

            if (activeCount > 0) {
                animationFrame = requestAnimationFrame(render);
            } else {
                ctx.clearRect(0, 0, cCanvas.width, cCanvas.height);
            }
        };

        render();
    }

    function renderActionOnCtx(targetCtx, rawAction, rect) {
        if (!rawAction) return;
        const action = rawAction.action || rawAction.data || rawAction;
        const width = rect.width;
        const height = rect.height;

        targetCtx.save();
        targetCtx.lineCap = 'round';
        targetCtx.lineJoin = 'round';
        targetCtx.lineWidth = action.size || 4;
        const strokeColor = action.tool === 'eraser' ? '#0f172a' : (action.color || '#ffffff');
        targetCtx.strokeStyle = strokeColor;

        if (action.tool === 'pen' || action.tool === 'eraser' || !action.tool) {
            if (action.points && action.points.length > 0) {
                targetCtx.beginPath();
                targetCtx.moveTo(action.points[0].x * width, action.points[0].y * height);
                for (let i = 1; i < action.points.length; i++) {
                    targetCtx.lineTo(action.points[i].x * width, action.points[i].y * height);
                }
                targetCtx.stroke();
            }
        } else if (action.tool === 'line') {
            targetCtx.beginPath();
            targetCtx.moveTo(action.startX * width, action.startY * height);
            targetCtx.lineTo(action.endX * width, action.endY * height);
            targetCtx.stroke();
        } else if (action.tool === 'rect') {
            targetCtx.beginPath();
            targetCtx.strokeRect(action.startX * width, action.startY * height, (action.endX - action.startX) * width, (action.endY - action.startY) * height);
        } else if (action.tool === 'circle') {
            targetCtx.beginPath();
            const sx = action.startX * width;
            const sy = action.startY * height;
            const ex = action.endX * width;
            const ey = action.endY * height;
            const radius = Math.sqrt(Math.pow(ex - sx, 2) + Math.pow(ey - sy, 2));
            targetCtx.arc(sx, sy, radius, 0, 2 * Math.PI);
            targetCtx.stroke();
        } else if (action.tool === 'text') {
            targetCtx.font = `${(action.size || 4) * 3 + 10}px Outfit, sans-serif`;
            targetCtx.fillStyle = action.color || '#ffffff';
            targetCtx.fillText(action.text || '', action.x * width, action.y * height);
        }
        targetCtx.restore();
    }

    function switchRoom() {
        const newRoom = (roomInput && roomInput.value.trim()) || roomId || 'default-room';
        roomId = newRoom;
        setURLRoomParam(roomId);
        if (currentRoomCodeDisplay) currentRoomCodeDisplay.textContent = roomId;
        canvasHistory = [];
        clearRemoteCursors();
        stickyNotesMap.forEach(v => v.el.remove());
        stickyNotesMap.clear();
        redrawFullCanvas();
        connectWebSocket();
        showToast(`Switched to room: ${roomId}`);
    }

    if (copyShareBtn) {
        copyShareBtn.addEventListener('click', () => {
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomId);
            navigator.clipboard.writeText(url.toString()).then(() => {
                showToast('Room link copied to clipboard!');
            }).catch(() => {
                showToast('Share URL: ' + url.toString());
            });
        });
    }

    // Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            sendWebSocketMessage({ type: 'undo' });
        } else if (e.key.toLowerCase() === 'p') {
            selectTool('pen');
        } else if (e.key.toLowerCase() === 'l') {
            selectTool('line');
        } else if (e.key.toLowerCase() === 'r') {
            selectTool('rect');
        } else if (e.key.toLowerCase() === 'c') {
            selectTool('circle');
        } else if (e.key.toLowerCase() === 's') {
            selectTool('sticky');
        } else if (e.key.toLowerCase() === 'e') {
            selectTool('eraser');
        }
    });

    function selectTool(toolName) {
        const btn = document.querySelector(`.tool-btn[data-tool="${toolName}"]`);
        if (btn) btn.click();
    }

    // Status & Toast Helper Utilities
    function updateConnectionStatus(state, text) {
        connectionBadge.className = `status-badge ${state}`;
        statusText.textContent = text;
    }

    function updateUserStack() {
        avatarStack.innerHTML = '';
        activeUsers.forEach(u => {
            const avatar = document.createElement('div');
            avatar.className = 'user-avatar';
            avatar.style.backgroundColor = u.color;
            avatar.title = u.name;
            avatar.textContent = getInitials(u.name);
            avatarStack.appendChild(avatar);
        });
    }

    function showToast(msg) {
        toastMessage.textContent = msg;
        toast.classList.remove('hidden');
        setTimeout(() => {
            toast.classList.add('hidden');
        }, 3000);
    }

    function getRoomIdFromURL() {
        const params = new URLSearchParams(window.location.search);
        return params.get('room');
    }

    function setURLRoomParam(room) {
        const url = new URL(window.location.href);
        url.searchParams.set('room', room);
        window.history.pushState({}, '', url);
    }

    // ==========================================================================
    // Room Gateway Lobby Controls (Create / Join Flow)
    // ==========================================================================
    if (gatewayNameInput) {
        gatewayNameInput.value = userName || `User#${Math.floor(1000 + Math.random() * 9000)}`;
        if (gatewayAvatarInitials) gatewayAvatarInitials.textContent = getInitials(gatewayNameInput.value);
        if (gatewayAvatarPreview) gatewayAvatarPreview.style.backgroundColor = userColor;

        gatewayNameInput.addEventListener('input', (e) => {
            const val = e.target.value.trim() || 'User';
            if (gatewayAvatarInitials) gatewayAvatarInitials.textContent = getInitials(val);
        });
    }

    if (gatewayCreateBtn) {
        gatewayCreateBtn.addEventListener('click', () => {
            const nameVal = gatewayNameInput ? gatewayNameInput.value.trim() : '';
            userName = nameVal || `User#${Math.floor(1000 + Math.random() * 9000)}`;
            localStorage.setItem('collabdraw_username', userName);

            // Generate 6-char random room code like GAME42
            const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            let randomCode = 'GAME';
            for (let i = 0; i < 2; i++) {
                randomCode += chars.charAt(Math.floor(Math.random() * chars.length));
            }

            roomId = randomCode;
            isHost = true;
            localStorage.setItem('collabdraw_host_' + roomId, 'true');
            setURLRoomParam(roomId);

            if (currentRoomCodeDisplay) currentRoomCodeDisplay.textContent = roomId;
            if (startGameBtn) {
                startGameBtn.classList.remove('hidden');
                startGameBtn.style.display = 'inline-flex';
            }

            roomGatewayModal.classList.add('hidden');
            roomGatewayModal.style.display = 'none';

            canvasHistory = [];
            clearRemoteCursors();
            stickyNotesMap.forEach(v => v.el.remove());
            stickyNotesMap.clear();
            redrawFullCanvas();

            connectWebSocket();
            showToast(`✨ Room Created! Room Code: ${roomId}`);
        });
    }

    if (gatewayJoinBtn) {
        gatewayJoinBtn.addEventListener('click', () => {
            const codeVal = gatewayRoomCodeInput ? gatewayRoomCodeInput.value.trim().toUpperCase() : '';
            if (!codeVal) {
                showToast('Please enter a room code to join!');
                if (gatewayRoomCodeInput) gatewayRoomCodeInput.focus();
                return;
            }

            const nameVal = gatewayNameInput ? gatewayNameInput.value.trim() : '';
            userName = nameVal || `User#${Math.floor(1000 + Math.random() * 9000)}`;
            localStorage.setItem('collabdraw_username', userName);

            roomId = codeVal;
            isHost = false;
            setURLRoomParam(roomId);

            if (currentRoomCodeDisplay) currentRoomCodeDisplay.textContent = roomId;
            if (startGameBtn) {
                startGameBtn.classList.add('hidden');
                startGameBtn.style.display = 'none';
            }

            roomGatewayModal.classList.add('hidden');
            roomGatewayModal.style.display = 'none';

            canvasHistory = [];
            clearRemoteCursors();
            stickyNotesMap.forEach(v => v.el.remove());
            stickyNotesMap.clear();
            redrawFullCanvas();

            connectWebSocket();
            showToast(`Joined Room: ${roomId}`);
        });
    }

    if (gatewayRoomCodeInput) {
        gatewayRoomCodeInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && gatewayJoinBtn) gatewayJoinBtn.click();
        });
    }

    function leaveCurrentRoom() {
        if (socket) socket.close();
        if (roomId) {
            sessionStorage.removeItem('collabdraw_host_' + roomId);
        }
        setURLRoomParam('');
        hideAllModals();
        if (landingModal) {
            landingModal.classList.remove('hidden');
            landingModal.style.display = 'flex';
        }
        showToast('🚪 Left room');
    }

    if (leaveRoomBtn) {
        leaveRoomBtn.addEventListener('click', leaveCurrentRoom);
    }

    if (copyRoomCodeBtn) {
        copyRoomCodeBtn.addEventListener('click', () => {
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomId);
            navigator.clipboard.writeText(url.toString()).then(() => {
                showToast(`Room link copied: ${url.toString()}`);
            }).catch(() => {
                showToast(`Room Code: ${roomId}`);
            });
        });
    }

    // ==========================================================================
    // Production Landing Page & Lobby Flow Management
    // ==========================================================================
    const landingModal = document.getElementById('landingModal');
    const landingNameInput = document.getElementById('landingNameInput');
    const avatarColorPickerGrid = document.getElementById('avatarColorPickerGrid');
    const createRoomLandingBtn = document.getElementById('createRoomLandingBtn');
    const joinRoomCodeLandingInput = document.getElementById('joinRoomCodeLandingInput');
    const joinRoomLandingBtn = document.getElementById('joinRoomLandingBtn');

    const lobbyModal = document.getElementById('lobbyModal');
    const lobbyRoomCodeDisplay = document.getElementById('lobbyRoomCodeDisplay');
    const copyLobbyInviteBtn = document.getElementById('copyLobbyInviteBtn');
    const lobbyPlayersGrid = document.getElementById('lobbyPlayersGrid');
    const lobbyPlayerCount = document.getElementById('lobbyPlayerCount');
    const hostControlPanel = document.getElementById('hostControlPanel');
    const lockDrawingToggleBtn = document.getElementById('lockDrawingToggleBtn');
    const lockDrawingIcon = document.getElementById('lockDrawingIcon');
    const lockDrawingText = document.getElementById('lockDrawingText');
    const roomModePillSelector = document.getElementById('roomModePillSelector');
    const launchSessionBtn = document.getElementById('launchSessionBtn');
    const leaveLobbyBtn = document.getElementById('leaveLobbyBtn');

    let isDrawingLocked = false;

    // Color Swatch Selection
    if (avatarColorPickerGrid) {
        avatarColorPickerGrid.querySelectorAll('.color-swatch').forEach(swatch => {
            swatch.addEventListener('click', () => {
                avatarColorPickerGrid.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
                swatch.classList.add('selected');
                userColor = swatch.dataset.color || '#38bdf8';
                localStorage.setItem('collabdraw_user_color', userColor);
            });
        });
    }

    // Restore saved profile settings
    const savedName = localStorage.getItem('collabdraw_user_name');
    if (savedName && landingNameInput) landingNameInput.value = savedName;
    const savedColor = localStorage.getItem('collabdraw_user_color');
    if (savedColor) {
        userColor = savedColor;
        if (avatarColorPickerGrid) {
            avatarColorPickerGrid.querySelectorAll('.color-swatch').forEach(s => {
                if (s.dataset.color === savedColor) s.classList.add('selected');
                else s.classList.remove('selected');
            });
        }
    }

    function generate6CharRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    // Landing Actions: Create Room (generates 6-character code e.g. WORK01)
    if (createRoomLandingBtn) {
        createRoomLandingBtn.addEventListener('click', () => {
            if (landingNameInput && landingNameInput.value.trim()) {
                userName = landingNameInput.value.trim();
                localStorage.setItem('collabdraw_user_name', userName);
            }

            const code = generate6CharRoomCode();
            roomId = code;
            isHost = true;
            sessionStorage.setItem('collabdraw_host_' + roomId, 'true');

            if (currentRoomCodeDisplay) currentRoomCodeDisplay.textContent = roomId;
            setURLRoomParam(roomId);

            if (landingModal) {
                landingModal.classList.add('hidden');
                landingModal.style.display = 'none';
            }

            connectWebSocket();
            showLobbyView(roomId);
            showToast(`✨ Room Created! Code: ${roomId}`);
        });
    }

    // Landing Actions: Join Room via 6-character code
    if (joinRoomLandingBtn) {
        joinRoomLandingBtn.addEventListener('click', () => {
            if (landingNameInput && landingNameInput.value.trim()) {
                userName = landingNameInput.value.trim();
                localStorage.setItem('collabdraw_user_name', userName);
            }
            const code = joinRoomCodeLandingInput ? joinRoomCodeLandingInput.value.trim().toUpperCase() : '';
            if (!code) {
                showToast('⚠️ Please enter a room code (e.g. WORK01)!');
                if (joinRoomCodeLandingInput) joinRoomCodeLandingInput.focus();
                return;
            }
            roomId = code;
            isHost = (sessionStorage.getItem('collabdraw_host_' + roomId) === 'true');
            if (currentRoomCodeDisplay) currentRoomCodeDisplay.textContent = roomId;
            setURLRoomParam(roomId);

            if (landingModal) {
                landingModal.classList.add('hidden');
                landingModal.style.display = 'none';
            }

            connectWebSocket();
            showLobbyView(roomId);
        });
    }

    if (joinRoomCodeLandingInput) {
        joinRoomCodeLandingInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && joinRoomLandingBtn) joinRoomLandingBtn.click();
        });
    }

    if (copyLobbyInviteBtn) {
        copyLobbyInviteBtn.addEventListener('click', () => {
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomId);
            navigator.clipboard.writeText(url.toString()).then(() => {
                showToast(`Copied invite link: ${url.toString()}`);
            }).catch(() => {
                showToast(`Room Code: ${roomId}`);
            });
        });
    }

    if (leaveLobbyBtn) {
        leaveLobbyBtn.addEventListener('click', leaveCurrentRoom);
    }

    // Host Controls: Drawing Permission Lock Toggle
    if (lockDrawingToggleBtn) {
        lockDrawingToggleBtn.addEventListener('click', () => {
            if (!isHost) return;
            isDrawingLocked = !isDrawingLocked;
            updateLockDrawingUI();
            sendWebSocketMessage({
                type: 'update_room_permissions',
                drawing_locked: isDrawingLocked
            });
        });
    }

    function updateLockDrawingUI() {
        if (lockDrawingIcon) lockDrawingIcon.textContent = isDrawingLocked ? '🔒' : '🔓';
        if (lockDrawingText) lockDrawingText.textContent = isDrawingLocked ? 'Locked (View Only)' : 'Unlocked (All Can Edit)';
        if (lockDrawingToggleBtn) {
            lockDrawingToggleBtn.className = isDrawingLocked ? 'btn btn-danger btn-sm-pill' : 'btn btn-secondary btn-sm-pill';
        }
    }

    let selectedSessionMode = 'whiteboard';

    // Host Controls: Room Mode Selector
    if (roomModePillSelector) {
        roomModePillSelector.querySelectorAll('.pill-option').forEach(pill => {
            pill.addEventListener('click', () => {
                if (!isHost) return;
                roomModePillSelector.querySelectorAll('.pill-option').forEach(p => p.classList.remove('active'));
                pill.classList.add('active');
                selectedSessionMode = pill.dataset.mode || 'whiteboard';
                showToast(`Session Mode set to: ${selectedSessionMode === 'game' ? 'Party Game' : 'Collaborative Canvas'}`);
            });
        });
    }

    // Host Action: Launch Session (Broadcasts start_session event to all peers)
    if (launchSessionBtn) {
        launchSessionBtn.addEventListener('click', (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (selectedSessionMode === 'game') {
                showToast('🚀 Launching Party Game...');
                sendWebSocketMessage({ type: 'start_game' });
            } else {
                showToast('🚀 Launching Collaborative Whiteboard Canvas...');
                sendWebSocketMessage({
                    type: 'start_session',
                    mode: 'whiteboard'
                });
            }
        });
    }

    function showLobbyView(code) {
        if (!lobbyModal) return;
        if (lobbyRoomCodeDisplay) lobbyRoomCodeDisplay.textContent = code;
        
        const hostInSession = (sessionStorage.getItem('collabdraw_host_' + code) === 'true');
        if (hostInSession) {
            isHost = true;
        } else if (activeUsers.length === 1 && activeUsers[0].client_id === clientId) {
            isHost = true;
            sessionStorage.setItem('collabdraw_host_' + code, 'true');
        }

        updateLobbyView();

        lobbyModal.classList.remove('hidden');
        lobbyModal.style.display = 'flex';
    }

    function updateLobbyView() {
        if (!lobbyPlayersGrid) return;
        lobbyPlayersGrid.innerHTML = '';

        if (lobbyPlayerCount) lobbyPlayerCount.textContent = activeUsers.length;

        const isMeHost = isHost || (sessionStorage.getItem('collabdraw_host_' + roomId) === 'true');
        if (isMeHost) isHost = true;

        activeUsers.forEach(u => {
            const isMe = (u.client_id === clientId);
            const isRoomHost = u.is_host || u.role === 'Host' || (isMe && isMeHost);
            const roleName = isRoomHost ? 'Host' : (u.role || 'Editor');
            const roleClass = isRoomHost ? 'host' : roleName.toLowerCase();

            const card = document.createElement('div');
            card.className = 'lobby-player-card';
            card.innerHTML = `
                <div class="lobby-player-avatar" style="background-color: ${u.color || '#38bdf8'};">
                    ${(u.name || 'U').charAt(0).toUpperCase()}
                </div>
                <div class="lobby-player-name">${u.name || 'User'}</div>
                <span class="role-badge ${roleClass}">${isRoomHost ? '👑 Host' : roleName}</span>
            `;
            lobbyPlayersGrid.appendChild(card);
        });

        if (hostControlPanel) {
            hostControlPanel.style.display = isHost ? 'flex' : 'none';
        }
        if (launchSessionBtn) {
            launchSessionBtn.style.display = isHost ? 'inline-flex' : 'none';
        }

        const participantWaitingBanner = document.getElementById('participantWaitingBanner');
        if (participantWaitingBanner) {
            participantWaitingBanner.style.display = isHost ? 'none' : 'flex';
        }
    }

    function updateLobbyPillUI() {
        if (roomModePillSelector) {
            roomModePillSelector.querySelectorAll('.pill-option').forEach(p => {
                if (p.dataset.mode === 'whiteboard') p.classList.add('active');
                else p.classList.remove('active');
            });
        }
    }

    const inProgressBackBtn = document.getElementById('inProgressBackBtn');
    if (inProgressBackBtn) {
        inProgressBackBtn.addEventListener('click', () => {
            hideAllModals();
            if (landingModal) {
                landingModal.classList.remove('hidden');
                landingModal.style.display = 'flex';
            }
        });
    }

    // Initialize Application Flow
    resizeCanvas();

    const urlRoom = getRoomIdFromURL();
    if (urlRoom) {
        roomId = urlRoom;
        if (currentRoomCodeDisplay) currentRoomCodeDisplay.textContent = roomId;
        if (joinRoomCodeLandingInput) joinRoomCodeLandingInput.value = roomId;

        if (landingModal) {
            landingModal.classList.add('hidden');
            landingModal.style.display = 'none';
        }

        connectWebSocket();
        showLobbyView(roomId);
    } else {
        if (landingModal) {
            landingModal.classList.remove('hidden');
            landingModal.style.display = 'flex';
        }
    }

})();


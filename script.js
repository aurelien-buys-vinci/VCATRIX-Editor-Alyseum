// --- CONFIGURATION CONSTANTS ---
const DEBUG_MODE = false;        // Set to false in production builds to avoid console/GC pauses at 10 Hz
const CLOCK_INTERVAL_MS = 100;   // Main monitoring clock interval (10 Hz)
const QUEUE_DELAY_MS = 90;       // Delay within the clock cycle (90 ms) to send queued commands
const TX_STAGGER_MS = 500;       // 500 ms delay between presets during Bulk Dump Transmit (Manual V1.6 p.9)
const POST_DUMP_DELAY_MS = 500;  // 500 ms delay before resuming monitoring after Bulk Dump (Manual V1.6 p.9)
const DUMP_TIMEOUT_MS = 2000;    // Failsafe timeout for incomplete bulk dumps
const MAX_IMPORT_FILE_SIZE = 1024 * 1024; // 1 MB max file size for safety

function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log("%c[DEBUG]%c", "color: #ffaa00; font-weight: bold;", "", ...args);
    }
}

function logMidiTx(msg) {
    if (DEBUG_MODE) {
        const hex = Array.from(msg).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        console.log(`%c[MIDI TX]%c ${hex}`, "color: #0088ff; font-weight: bold;", "");
    }
}

function logMidiRx(msg) {
    if (DEBUG_MODE) {
        const hex = Array.from(msg).map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
        console.log(`%c[MIDI RX]%c ${hex}`, "color: #00aa00; font-weight: bold;", "");
    }
}

// --- GLOBAL STATE VARIABLES ---
let midiAccess = null;
let midiInPort = null;
let midiOutPort = null;
let isDumpInProgress = false;
let pendingSaveFileHandle = null;
let pendingSaveFilename = null;
let pendingSaveSelection = 'all';

// Communication strategy variables
let isMonitoringActive = false;
let mainClockInterval = null;
let secondaryTickTimeout = null;
let vcaUpdateMap = new Map(); // Merges values for the same fader before sending at 10 Hz
let pendingCommands = [];     // Queue for Clear (0x01) and Preset (0x02) commands
let skipNextDisplay = false;  // Anti-collision flag for the MIDI bus (Manual V1.6 p.9)

// UI interaction & selection state
let isMultiSelectMode = false;
let selectedVCAs = [];
let isDraggingFader = false;
let activeDragState = null;
let currentHoveredFader = null;

// 2D Array storing the 64 fader values
const vcaLevels = Array.from({ length: 8 }, () => Array(8).fill(0));

// 2D Array storing the local edit state (true = edited locally [red], false = default [green])
const vcaEditedLocally = Array.from({ length: 8 }, () => Array(8).fill(false));

// Alyseum SysEx Header (Manufacturer ID + Device ID 0x0A)
const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x09, 0x0a];

// Buffer for storing incoming Bulk Dump presets
let dumpBuffer = {};
let dumpTimeout = null;
let expectedDumpCount = 16;
let transmitTimeouts = [];

// ==========================================
// SAFE MIDI SENDER HELPER
// ==========================================

function safeMidiSend(message) {
    if (!midiOutPort || midiOutPort.state === 'disconnected') {
        return false;
    }
    try {
        midiOutPort.send(message);
        logMidiTx(message);
        return true;
    } catch (err) {
        console.error("MIDI Outbound Error:", err);
        return false;
    }
}

// ==========================================
// CORE MIDI OUTBOUND FUNCTIONS (IMMEDIATE)
// These functions send data physically to the MIDI port
// ==========================================

function sendClearAllVCAImmediate() {
    const message = [...SYSEX_HEADER, 0x01, 0xf7];
    return safeMidiSend(message);
}

function sendSetPresetImmediate(presetNum) {
    const pt = Math.max(0, Math.min(15, presetNum));
    const message = [...SYSEX_HEADER, 0x02, pt, 0xf7];
    return safeMidiSend(message);
}

function sendDisplayRequestImmediate() {
    const message = [...SYSEX_HEADER, 0x03, 0xf7];
    return safeMidiSend(message);
}

function sendUpdateVCAsImmediate(vcaList) {
    if (!vcaList || vcaList.length === 0) return false;
    const updates = vcaList.slice(0, 8);
    const message = [...SYSEX_HEADER, 0x04];

    updates.forEach(vca => {
        message.push(Math.max(0, Math.min(63, vca.address)));
        message.push(Math.max(0, Math.min(127, vca.value)));
    });

    message.push(0xf7);
    return safeMidiSend(message);
}

// ==========================================
// QUEUEING FUNCTIONS (Called by UI)
// These functions store actions to be executed during the 90 ms queue delay tick (10 Hz max)
// ==========================================

function sendClearAllVCA() {
    pendingCommands.push({ type: 'clear' });
}

function sendSetPreset(presetNum) {
    pendingCommands.push({ type: 'preset', value: presetNum });
}

function sendUpdateVCAs(vcaList) {
    vcaList.forEach(vca => {
        // The Map automatically overwrites older values for the same address,
        // ensuring only the latest fader position is sent at the next 10 Hz tick (90 ms)
        vcaUpdateMap.set(vca.address, vca.value);
    });
}

function resetDumpRxState() {
    if (dumpTimeout) {
        clearTimeout(dumpTimeout);
        dumpTimeout = null;
    }
    const rxButton = document.getElementById('btn-dump-rx');
    if (rxButton) {
        rxButton.disabled = false;
        rxButton.innerText = "Receive (save to computer)";
    }
    setTimeout(() => {
        isDumpInProgress = false;
    }, POST_DUMP_DELAY_MS);
}

// Command 0x05: Request hardware to send a Bulk Dump to Editor (Pauses 10 Hz clock)
function sendDumpRequest(presetNum) {
    if (!midiOutPort) return;

    isDumpInProgress = true;
    dumpBuffer = {};
    expectedDumpCount = (presetNum === 0x7f) ? 16 : 1;

    const rxButton = document.getElementById('btn-dump-rx');
    if (rxButton) {
        rxButton.disabled = true;
        rxButton.innerText = "Receiving... 0%";
    }

    if (dumpTimeout) clearTimeout(dumpTimeout);
    const initialTimeoutMs = (expectedDumpCount === 16) ? DUMP_TIMEOUT_MS * 3 : DUMP_TIMEOUT_MS;
    dumpTimeout = setTimeout(() => {
        if (Object.keys(dumpBuffer).length > 0) {
            console.warn("Timeout: Incomplete Dump received, saving partial file.");
            downloadBulkDumpFile(dumpBuffer);
        } else {
            console.warn("Timeout: No response from VCATRIX hardware.");
            alert("Timeout: No response received from the VCATRIX hardware.");
        }
        dumpBuffer = {};
        resetDumpRxState();
    }, initialTimeoutMs);

    const message = [...SYSEX_HEADER, 0x05, presetNum, 0xf7];
    if (!safeMidiSend(message)) {
        dumpBuffer = {};
        resetDumpRxState();
    }
}

// Command 0x06: Transmit Bulk Dump from Editor to overwrite hardware memory
function sendBulkDumpTransmit(bulkData) {
    if (!midiOutPort || !bulkData) return;

    isDumpInProgress = true;
    transmitTimeouts.forEach(t => clearTimeout(t));
    transmitTimeouts = [];

    const txButton = document.getElementById('btn-dump-tx');
    if (txButton) {
        txButton.disabled = true;
        txButton.innerText = "Transmitting... 0%";
    }

    let presetsToTransmit = [];
    for (let i = 0; i < 16; i++) {
        if (isValidPresetArray(bulkData[i])) {
            presetsToTransmit.push(i);
        }
    }

    let completed = 0;
    const total = presetsToTransmit.length;

    if (total === 0) {
        isDumpInProgress = false;
        if (txButton) {
            txButton.disabled = false;
            txButton.innerText = "Transmit (load file to VCATRIX)";
        }
        return;
    }

    presetsToTransmit.forEach((presetIdx, index) => {
        const timerId = setTimeout(() => {
            const message = [...SYSEX_HEADER, 0x06, presetIdx];
            bulkData[presetIdx].forEach(val => message.push(Math.max(0, Math.min(127, val))));
            message.push(0xf7);

            safeMidiSend(message);
            debugLog(`Preset ${presetIdx} transmitted.`);

            completed++;
            if (txButton) {
                const percentage = Math.round((completed / total) * 100);
                txButton.innerText = `Transmitting... ${percentage}%`;
            }

            if (completed === total) {
                const endTimerId = setTimeout(() => {
                    isDumpInProgress = false;
                    if (txButton) {
                        txButton.disabled = false;
                        txButton.innerText = "Transmit (load file to VCATRIX)";
                    }
                }, POST_DUMP_DELAY_MS);
                transmitTimeouts.push(endTimerId);
            }
        }, index * TX_STAGGER_MS);
        transmitTimeouts.push(timerId);
    });
}

// ==========================================
// MAIN CLOCK LOGIC (10 Hz + 90 ms Queue Slot)
// ==========================================

function startMainClock() {
    if (mainClockInterval) clearInterval(mainClockInterval);
    if (secondaryTickTimeout) clearTimeout(secondaryTickTimeout);

    mainClockInterval = setInterval(() => {
        if (isDumpInProgress) return;

        // --- MAIN TICK (T = 0 ms): DISPLAY REQUEST (~2 ms TX, ~30 ms RX) ---
        if (isMonitoringActive && !skipNextDisplay) {
            sendDisplayRequestImmediate();
        }
        skipNextDisplay = false;

        // --- SECONDARY TICK (T = 90 ms): Commands & VCA Updates (Strictly 10 times/sec max) ---
        if (secondaryTickTimeout) clearTimeout(secondaryTickTimeout);
        secondaryTickTimeout = setTimeout(() => {
            if (isDumpInProgress) return;

            let sentCommandAt90ms = false;

            // 1. Process global commands (Clear / Preset) in FIFO order
            if (pendingCommands.length > 0) {
                const cmd = pendingCommands.shift();
                if (cmd.type === 'clear') {
                    sendClearAllVCAImmediate();
                    sentCommandAt90ms = true;
                } else if (cmd.type === 'preset') {
                    sendSetPresetImmediate(cmd.value);
                    sentCommandAt90ms = true;
                    if (!isMonitoringActive) {
                        setTimeout(() => {
                            if (!isDumpInProgress) sendDisplayRequestImmediate();
                        }, 100);
                    }
                }
            }

            // 2. Process modified VCAs (Faders) - Strictly 1 packet (max 8 VCAs) per 100 ms cycle (10 Hz)
            if (vcaUpdateMap.size > 0) {
                const updates = Array.from(vcaUpdateMap.entries()).map(([address, value]) => ({ address, value }));
                const chunk = updates.slice(0, 8);
                chunk.forEach(item => vcaUpdateMap.delete(item.address));

                sendUpdateVCAsImmediate(chunk);
                sentCommandAt90ms = true;
            }

            // Per Manual V1.6 p.9: Command 0x04 at T = 90 ms (~10 ms duration)
            // is equivalent to and replaces the immediately following DISPLAY Request at T = 100 ms
            if (sentCommandAt90ms) {
                skipNextDisplay = true;
            }
        }, QUEUE_DELAY_MS);

    }, CLOCK_INTERVAL_MS);
}

// ==========================================
// CORE MIDI INBOUND ROUTER
// ==========================================

function handleIncomingMidi(message) {
    const data = message.data;
    if (!data || data.length < 6) return;

    if (data[0] !== 0xf0 || data[1] !== 0x00 || data[2] !== 0x20 || data[3] !== 0x09) {
        return;
    }
    if (data[4] !== 0x0a) return;
    if (data[data.length - 1] !== 0xf7) return;

    logMidiRx(data);

    const type = data[5];

    // Command 0x10 (or legacy 0x41): DISPLAY 64 successive VCA Values (71 bytes total)
    if (type === 0x10 || type === 0x41) {
        if (data.length < 71) return;
        let index = 6;
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            for (let inIdx = 0; inIdx < 8; inIdx++) {
                const newVal = Math.max(0, Math.min(127, data[index]));

                // Check if this VCA is currently being dragged by the user
                const isDraggedGroup = isDraggingFader && activeDragState &&
                    selectedVCAs.some(v => v.inIdx === activeDragState.inIdx && v.outIdx === activeDragState.outIdx) &&
                    selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);
                const isDraggedSingle = isDraggingFader && activeDragState &&
                    activeDragState.inIdx === inIdx && activeDragState.outIdx === outIdx;

                // Do not overwrite local fader UI while the user is actively dragging it
                if (!isDraggedSingle && !isDraggedGroup) {
                    if (vcaLevels[outIdx][inIdx] !== newVal) {
                        vcaLevels[outIdx][inIdx] = newVal;
                        drawFader(`Conn_${inIdx}_${outIdx}`, newVal);
                    }
                }
                index++;
            }
        }
    }
    // Command 0x11: DUMP Receive (72 bytes total)
    else if (type === 0x11) {
        if (!isDumpInProgress || data.length < 72) return;
        const presetNum = data[6];
        if (presetNum >= 16) return;

        const dumpValues = [];
        for (let i = 7; i < 7 + 64; i++) {
            dumpValues.push(Math.max(0, Math.min(127, data[i])));
        }

        dumpBuffer[presetNum] = dumpValues;

        const rxButton = document.getElementById('btn-dump-rx');
        const receivedCount = Object.keys(dumpBuffer).length;
        if (rxButton) {
            const percentage = Math.round((receivedCount / expectedDumpCount) * 100);
            rxButton.innerText = `Receiving... ${percentage}%`;
        }

        if (dumpTimeout) clearTimeout(dumpTimeout);

        if (receivedCount >= expectedDumpCount) {
            downloadBulkDumpFile(dumpBuffer);
            dumpBuffer = {};
            resetDumpRxState();
        } else {
            dumpTimeout = setTimeout(() => {
                console.warn("Timeout: Incomplete Dump received, saving partial file.");
                downloadBulkDumpFile(dumpBuffer);
                dumpBuffer = {};
                resetDumpRxState();
            }, DUMP_TIMEOUT_MS);
        }
    }
}

// ==========================================
// MIDI SETUP & CONNECTION
// ==========================================

function checkMidiPortSelection() {
    const inSelect = document.getElementById('midi-in');
    const outSelect = document.getElementById('midi-out');
    const btnConnect = document.getElementById('btn-connect');
    if (inSelect && outSelect && btnConnect) {
        btnConnect.disabled = (inSelect.value === "" || outSelect.value === "");
    }
}

document.getElementById('midi-in')?.addEventListener('change', checkMidiPortSelection);
document.getElementById('midi-out')?.addEventListener('change', checkMidiPortSelection);

async function startMidi() {
    debugLog("Initializing Web MIDI Access...");
    if (!navigator.requestMIDIAccess) {
        document.getElementById('btn-connect').disabled = true;
        document.getElementById('midi-setup').classList.add('hidden');
        document.getElementById('browser-warning').classList.remove('hidden');
        return;
    }
    try {
        midiAccess = await navigator.requestMIDIAccess({ sysex: true });
        debugLog("Web MIDI Access granted successfully.");
        populateMidiSelects();
        midiAccess.onstatechange = populateMidiSelects;
    } catch (err) {
        console.warn("MIDI access request failed or rejected.", err);
        document.getElementById('btn-connect').disabled = true;
        document.getElementById('midi-setup').classList.add('hidden');
        document.getElementById('browser-warning').classList.remove('hidden');
    }
}

function populateMidiSelects() {
    debugLog("Scanning MIDI devices and populating ports select dropdowns...");
    const inSelect = document.getElementById('midi-in');
    const outSelect = document.getElementById('midi-out');

    const currentIn = inSelect.value;
    const currentOut = outSelect.value;

    inSelect.innerHTML = '<option value="">Please Select</option>';
    outSelect.innerHTML = '<option value="">Please Select</option>';

    for (const input of midiAccess.inputs.values()) {
        const option = document.createElement('option');
        option.value = input.id;
        option.text = input.name;
        inSelect.add(option);
    }
    for (const output of midiAccess.outputs.values()) {
        const option = document.createElement('option');
        option.value = output.id;
        option.text = output.name;
        outSelect.add(option);
    }

    if (currentIn && midiAccess.inputs.has(currentIn)) inSelect.value = currentIn;
    if (currentOut && midiAccess.outputs.has(currentOut)) outSelect.value = currentOut;

    checkMidiPortSelection();
}

function launchApp(isDemoMode) {
    debugLog(`Launching application setup in ${isDemoMode ? "DEMO" : "MIDI"} mode...`);
    document.getElementById('setup-header').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    generateMatrix();

    // Start the global clock when the editor interface is launched
    startMainClock();

    if (isDemoMode) {
        debugLog("Started in DEMO Mode: MIDI transmission is disabled.");
    } else {
        debugLog("MIDI Connection successfully established.");
    }
}

document.getElementById('btn-connect').addEventListener('click', () => {
    const inId = document.getElementById('midi-in').value;
    const outId = document.getElementById('midi-out').value;

    midiInPort = midiAccess ? midiAccess.inputs.get(inId) : null;
    midiOutPort = midiAccess ? midiAccess.outputs.get(outId) : null;

    if (!midiInPort || !midiOutPort) {
        alert("Selected MIDI ports are no longer available. Please reselect.");
        populateMidiSelects();
        return;
    }

    debugLog(`Connection requested. Input: "${midiInPort.name}" (${inId}), Output: "${midiOutPort.name}" (${outId})`);

    midiInPort.onmidimessage = handleIncomingMidi;

    launchApp(false);
});

document.getElementById('btn-demo').addEventListener('click', () => {
    midiInPort = null;
    midiOutPort = null;
    launchApp(true);
});

// ==========================================
// EDITABLE LABELS LOGIC & STORAGE
// ==========================================

function getSavedLabels() {
    try {
        const saved = localStorage.getItem('vcatrixLabels');
        const parsed = saved ? JSON.parse(saved) : {};
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (err) {
        console.warn("Could not read saved labels from localStorage:", err);
        return {};
    }
}

function SaveLabel(labelId, newValue) {
    debugLog(`Saving label - id: "${labelId}", value: "${newValue}"`);
    try {
        const labels = getSavedLabels();
        labels[labelId] = newValue;
        localStorage.setItem('vcatrixLabels', JSON.stringify(labels));
    } catch (err) {
        console.warn("Could not save label to localStorage:", err);
    }
}

function makeHeaderEditable(headerElement) {
    headerElement.contentEditable = "true";
    headerElement.style.cursor = "text";

    headerElement.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.blur();
            return;
        }

        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
            const selection = window.getSelection().toString();
            if (this.innerText.length >= 8 && selection === '') {
                e.preventDefault();
            }
        }
    });

    headerElement.addEventListener('paste', function(e) {
        e.preventDefault();
        const text = (e.originalEvent || e).clipboardData.getData('text/plain');
        const remainingSpace = 8 - this.innerText.length;
        if (remainingSpace > 0) {
            document.execCommand('insertText', false, text.substring(0, remainingSpace));
        }
    });

    headerElement.addEventListener('blur', function() {
        const newValue = this.innerText.trim().substring(0, 8);
        SaveLabel(this.id, newValue);
    });
}

// ==========================================
// UI GENERATION & INTERACTION
// ==========================================

let resizeObserver = null;

function resizeAndDrawAll() {
    const canvases = document.querySelectorAll('.fader-container canvas');
    canvases.forEach(canvas => {
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            const dpr = window.devicePixelRatio || 1;
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;

            const parts = canvas.id.split('_');
            const inIdx = parseInt(parts[1], 10);
            const outIdx = parseInt(parts[2], 10);
            drawFader(canvas.id, vcaLevels[outIdx][inIdx] || 0);
        }
    });
}

function setupResizeObserver() {
    if (resizeObserver) {
        resizeObserver.disconnect();
    }
    const container = document.getElementById('matrix-container');
    if (container) {
        resizeObserver = new ResizeObserver(() => {
            resizeAndDrawAll();
        });
        resizeObserver.observe(container);
    }
}

function applyHighlightForFader(inIdx, outIdx, shouldHighlight) {
    const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);

    if (!isMultiSelectMode && isSelected && selectedVCAs.length > 0) {
        selectedVCAs.forEach(v => {
            const labelIn = document.getElementById(`label-in-${v.inIdx}`);
            const labelOut = document.getElementById(`label-out-${v.outIdx}`);
            if (labelIn) labelIn.classList.toggle('highlight', shouldHighlight);
            if (labelOut) labelOut.classList.toggle('highlight', shouldHighlight);
        });
    } else {
        const labelIn = document.getElementById(`label-in-${inIdx}`);
        const labelOut = document.getElementById(`label-out-${outIdx}`);
        if (labelIn) labelIn.classList.toggle('highlight', shouldHighlight);
        if (labelOut) labelOut.classList.toggle('highlight', shouldHighlight);
    }
}

function clearAllLabelHighlights() {
    document.querySelectorAll('.axis-label.highlight').forEach(el => {
        el.classList.remove('highlight');
    });
}

// Single global mousemove and mouseup listeners for fader dragging
window.addEventListener('mousemove', (e) => {
    if (activeDragState && !isMultiSelectMode) {
        activeDragState.handleMovement(e);
    }
});

window.addEventListener('mouseup', () => {
    if (activeDragState) {
        activeDragState = null;
        isDraggingFader = false;
        // Restore highlight for whichever fader the cursor is currently hovering
        clearAllLabelHighlights();
        if (currentHoveredFader) {
            applyHighlightForFader(currentHoveredFader.inIdx, currentHoveredFader.outIdx, true);
        }
    }
});

function generateMatrix() {
    const container = document.getElementById('matrix-container');
    container.innerHTML = '';
    const savedLabels = getSavedLabels();

    for (let row = 0; row <= 8; row++) {
        for (let col = 0; col <= 8; col++) {
            if (row === 0 && col === 0) {
                container.appendChild(document.createElement('div'));
            } else if (row === 0) {
                const outIdx = col - 1;
                const label = document.createElement('div');
                label.id = `label-out-${outIdx}`;
                label.className = 'axis-label top';
                label.innerText = savedLabels[label.id] || `OUT ${col}`;
                makeHeaderEditable(label);
                container.appendChild(label);
            } else if (col === 0) {
                const inIdx = row - 1;
                const label = document.createElement('div');
                label.id = `label-in-${inIdx}`;
                label.className = 'axis-label left';
                label.innerText = savedLabels[label.id] || `IN ${row}`;
                makeHeaderEditable(label);
                container.appendChild(label);
            } else {
                const inIdx = row - 1;
                const outIdx = col - 1;

                const faderDiv = document.createElement('div');
                faderDiv.className = 'fader-container';
                if (selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx)) {
                    faderDiv.classList.add('selected');
                }
                const canvas = document.createElement('canvas');
                canvas.id = `Conn_${inIdx}_${outIdx}`;

                faderDiv.appendChild(canvas);
                container.appendChild(faderDiv);

                setupCanvasInteraction(canvas, inIdx, outIdx);
            }
        }
    }

    // Draw all canvases with correct physical dimensions
    resizeAndDrawAll();
    // Watch for size changes
    setupResizeObserver();
}

function drawFader(canvasId, value) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    if (size === 0) return;

    const padding = Math.max(6, size * 0.1);
    const trackLength = size - 2 * padding;

    const parts = canvasId.split('_');
    const inI = parseInt(parts[1], 10);
    const outI = parseInt(parts[2], 10);
    const isEditedLocally = vcaEditedLocally[outI][inI];

    ctx.clearRect(0, 0, size, size);

    ctx.beginPath();
    ctx.moveTo(padding, size - padding);
    ctx.lineTo(size - padding, padding);
    ctx.strokeStyle = '#636563';
    ctx.lineWidth = Math.max(1.5, size * 0.02);
    ctx.stroke();

    const pos = value / 127;
    const x = padding + pos * trackLength;
    const y = (size - padding) - pos * trackLength;

    ctx.beginPath();
    ctx.arc(x, y, Math.max(4, size * 0.06), 0, 2 * Math.PI);
    ctx.fillStyle = isEditedLocally ? '#ff0000' : '#00ff00';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1, size * 0.02);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${Math.max(10, size * 0.14)}px Arial`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(value, size * 0.25, size * 0.25);
}

function setupCanvasInteraction(canvas, inIdx, outIdx) {
    let lastVal = -1;

    const calculateValue = (e) => {
        const rect = canvas.getBoundingClientRect();
        const padding = Math.max(6, rect.width * 0.1);
        const trackLength = rect.width - 2 * padding;
        if (trackLength <= 0) return 0;
        const diagonalPos = ((e.clientX - rect.left - padding) + (trackLength - (e.clientY - rect.top - padding))) / 2;
        let value = Math.round((diagonalPos / trackLength) * 127);
        return Math.max(0, Math.min(127, value));
    };

    const handleMovement = (e) => {
        const val = calculateValue(e);
        if (val === lastVal) return;
        lastVal = val;
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);

        if (isSelected && selectedVCAs.length > 0) {
            const updates = selectedVCAs.map(v => {
                vcaEditedLocally[v.outIdx][v.inIdx] = true;
                // Optimistic UI update: always redraw immediately under the mouse cursor
                vcaLevels[v.outIdx][v.inIdx] = val;
                drawFader(v.canvasId, val);
                return { address: v.inIdx + (8 * v.outIdx), value: val };
            });
            // Queued in vcaUpdateMap and sent strictly at 10 Hz (every 100 ms at the 90 ms slot)
            sendUpdateVCAs(updates);
        } else {
            vcaEditedLocally[outIdx][inIdx] = true;
            // Optimistic UI update: always redraw immediately under the mouse cursor
            vcaLevels[outIdx][inIdx] = val;
            drawFader(canvas.id, val);
            // Queued in vcaUpdateMap and sent strictly at 10 Hz (every 100 ms at the 90 ms slot)
            sendUpdateVCAs([{ address: inIdx + (8 * outIdx), value: val }]);
        }
    };

    canvas.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Prevents accidental text selection on labels while dragging outside the fader
        if (isMultiSelectMode) {
            const idx = selectedVCAs.findIndex(v => v.inIdx === inIdx && v.outIdx === outIdx);
            if (idx > -1) {
                selectedVCAs.splice(idx, 1);
                canvas.parentElement.classList.remove('selected');
            } else {
                if (selectedVCAs.length < 8) {
                    selectedVCAs.push({ inIdx, outIdx, canvasId: canvas.id });
                    canvas.parentElement.classList.add('selected');
                } else {
                    alert("You can only select up to 8 VCAs at the same time.");
                }
            }
            document.getElementById('btn-clear-selection').classList.toggle('hidden', selectedVCAs.length === 0);
        } else {
            isDraggingFader = true;
            lastVal = -1;
            activeDragState = { inIdx, outIdx, handleMovement };
            // Lock the active fader's (or selected group's) axis labels for the entire drag operation
            clearAllLabelHighlights();
            applyHighlightForFader(inIdx, outIdx, true);
            handleMovement(e);
        }
    });

    canvas.addEventListener('mouseenter', () => {
        currentHoveredFader = { inIdx, outIdx };
        // Do not change label highlights if a fader is currently being dragged
        if (isDraggingFader) return;
        applyHighlightForFader(inIdx, outIdx, true);
    });

    canvas.addEventListener('mouseleave', () => {
        if (currentHoveredFader && currentHoveredFader.inIdx === inIdx && currentHoveredFader.outIdx === outIdx) {
            currentHoveredFader = null;
        }
        // Do not clear label highlights if a fader is currently being dragged outside its frame
        if (isDraggingFader) return;
        applyHighlightForFader(inIdx, outIdx, false);
    });
}

function resetAllColorsToGreen() {
    for (let inIdx = 0; inIdx < 8; inIdx++) {
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            vcaEditedLocally[outIdx][inIdx] = false;
            drawFader(`Conn_${inIdx}_${outIdx}`, vcaLevels[outIdx][inIdx]);
        }
    }
}

// ==========================================
// SIDEBAR EVENT LISTENERS & MODALS
// ==========================================

document.getElementById('btn-multi-select').addEventListener('click', (e) => {
    isMultiSelectMode = !isMultiSelectMode;
    debugLog(`Multi-Select Mode toggled: ${isMultiSelectMode ? "ENABLED" : "DISABLED"}`);
    e.target.innerText = isMultiSelectMode ? "Multi-Select: ON" : "Multi-Select: OFF";
    e.target.classList.toggle('active', isMultiSelectMode);
});

document.getElementById('btn-clear-selection').addEventListener('click', () => {
    debugLog(`Clearing multi-select fader selection. Count: ${selectedVCAs.length}`);
    selectedVCAs.forEach(v => document.getElementById(v.canvasId)?.parentElement.classList.remove('selected'));
    selectedVCAs = [];
    document.getElementById('btn-clear-selection').classList.add('hidden');
    clearAllLabelHighlights();
    if (currentHoveredFader) {
        applyHighlightForFader(currentHoveredFader.inIdx, currentHoveredFader.outIdx, true);
    }
});

document.getElementById('btn-clear').addEventListener('click', () => {
    for (let inIdx = 0; inIdx < 8; inIdx++) {
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            vcaEditedLocally[outIdx][inIdx] = false;
            vcaLevels[outIdx][inIdx] = 0;
            drawFader(`Conn_${inIdx}_${outIdx}`, 0);
        }
    }
    sendClearAllVCA(); // Added to queue
});

document.getElementById('btn-monitor').addEventListener('click', (e) => {
    isMonitoringActive = !isMonitoringActive;
    debugLog(`10Hz Hardware Monitoring toggled: ${isMonitoringActive ? "ENABLED" : "DISABLED"}`);

    if (!isMonitoringActive) {
        e.target.innerText = "Enable monitoring (10Hz)";
        e.target.style.backgroundColor = "#ff0000";
    } else {
        e.target.innerText = "Disable monitoring";
        e.target.style.backgroundColor = "#00aa00";
        // Synchronized with startMainClock() next T = 0 ms tick to avoid out-of-phase collisions
    }
});

document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        resetAllColorsToGreen();

        const presetNum = parseInt(e.target.getAttribute('data-preset'), 10);
        debugLog(`Preset selected: Preset ${presetNum + 1}`);

        if (!midiOutPort) return;
        sendSetPreset(presetNum); // Added to queue
    });
});

document.getElementById('btn-dump-rx').addEventListener('click', () => {
    if (isDumpInProgress) return;
    document.getElementById('receive-select').value = "all";
    document.getElementById('receive-modal').classList.remove('hidden');
});

document.getElementById('btn-receive-cancel').addEventListener('click', () => {
    document.getElementById('receive-modal').classList.add('hidden');
});

function getSuggestedFilename(selection) {
    const sel = selection || pendingSaveSelection || 'all';
    const now = new Date();
    const formattedDate = `${String(now.getDate()).padStart(2, '0')}_${String(now.getMonth() + 1).padStart(2, '0')}_${now.getFullYear()}`;
    if (sel === 'all') {
        return `VCATRIX_BULK_ALL_${formattedDate}.vca`;
    } else {
        const presetNum = parseInt(sel, 10);
        return `VCATRIX_BULK_PRESET_${presetNum + 1}_${formattedDate}.vca`;
    }
}

document.getElementById('btn-receive-confirm').addEventListener('click', async () => {
    const selection = document.getElementById('receive-select').value;
    pendingSaveSelection = selection;
    const presetVal = (selection === 'all') ? 0x7F : parseInt(selection, 10);
    debugLog(`Receive Bulk Dump confirmed. Selection: ${selection === 'all' ? 'All Presets' : 'Preset ' + (presetVal + 1)}`);

    const defaultFilename = getSuggestedFilename(selection);
    pendingSaveFileHandle = null;
    pendingSaveFilename = null;

    if ('showSaveFilePicker' in window) {
        try {
            pendingSaveFileHandle = await window.showSaveFilePicker({
                suggestedName: defaultFilename,
                types: [{
                    description: 'VCATRIX Data File',
                    accept: {
                        'application/json': ['.vca', '.json']
                    }
                }]
            });
        } catch (err) {
            if (err.name === 'AbortError') {
                debugLog('Save operations aborted by user.');
                return; // Cancel clicked in native dialog, abort the whole dump
            }
            console.warn('showSaveFilePicker failed, falling back to prompt:', err);
        }
    }

    if (!pendingSaveFileHandle) {
        let filename = prompt("Enter a filename for your backup:", defaultFilename);
        if (filename === null) return; // Cancel clicked in prompt, abort the whole dump
        if (!filename.trim()) {
            filename = defaultFilename;
        }
        if (!filename.endsWith('.vca') && !filename.endsWith('.json')) {
            filename += '.vca';
        }
        pendingSaveFilename = filename;
    }

    document.getElementById('receive-modal').classList.add('hidden');
    sendDumpRequest(presetVal);
});

async function downloadBulkDumpFile(bulkData) {
    const exportPayload = { ...bulkData, labels: getSavedLabels() };
    const jsonString = JSON.stringify(exportPayload, null, 2);

    if (pendingSaveFileHandle) {
        try {
            const writable = await pendingSaveFileHandle.createWritable();
            await writable.write(jsonString);
            await writable.close();
            pendingSaveFileHandle = null;
            pendingSaveFilename = null;
            return;
        } catch (err) {
            console.error('Error writing to saved file handle:', err);
            pendingSaveFileHandle = null;
        }
    }

    const filename = pendingSaveFilename || getSuggestedFilename();
    const blob = new Blob([jsonString], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    pendingSaveFilename = null;
}

// --- TRANSMIT MODAL & FILE VALIDATION LOGIC ---
let pendingBulkData = null;

function isValidPresetArray(preset) {
    return Array.isArray(preset) &&
        preset.length === 64 &&
        preset.every(val => Number.isInteger(val) && val >= 0 && val <= 127);
}

function isValidLabelsObject(labels) {
    if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return false;
    return Object.entries(labels).every(([key, val]) =>
        typeof key === 'string' && typeof val === 'string' && val.length <= 16
    );
}

document.getElementById('btn-dump-tx').addEventListener('click', () => {
    if (isDumpInProgress) return;
    document.getElementById('file-upload').click();
});

document.getElementById('file-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > MAX_IMPORT_FILE_SIZE) {
        alert("Error: File is too large (maximum 1 MB).");
        e.target.value = '';
        return;
    }

    debugLog(`File selected for upload: "${file.name}" (${file.size} bytes). Reading...`);

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const bulkData = JSON.parse(event.target.result);
            if (!bulkData || typeof bulkData !== 'object' || Array.isArray(bulkData)) {
                alert("Invalid File Format.");
                return;
            }

            // Validate presets atomically before applying any changes
            let availablePresets = [];
            for (let i = 0; i < 16; i++) {
                if (bulkData[i] !== undefined) {
                    if (!isValidPresetArray(bulkData[i])) {
                        alert(`Invalid File Format: Preset ${i + 1} contains invalid MIDI values (must be 64 integers between 0 and 127).`);
                        return;
                    }
                    availablePresets.push(i);
                }
            }

            let labelsLoaded = false;
            if (bulkData.labels !== undefined) {
                if (!isValidLabelsObject(bulkData.labels)) {
                    alert("Invalid File Format: Labels structure is invalid.");
                    return;
                }
                try {
                    localStorage.setItem('vcatrixLabels', JSON.stringify(bulkData.labels));
                    generateMatrix();
                    labelsLoaded = true;
                } catch (storageErr) {
                    console.warn("Could not store imported labels in localStorage:", storageErr);
                }
            }

            if (availablePresets.length > 0) {
                pendingBulkData = bulkData;
                const select = document.getElementById('transmit-select');
                select.innerHTML = ''; // Clear existing hardcoded options

                if (availablePresets.length > 1) {
                    const allOption = document.createElement('option');
                    allOption.value = "all";
                    allOption.text = "All Presets";
                    select.add(allOption);
                }

                availablePresets.forEach(presetIdx => {
                    const option = document.createElement('option');
                    option.value = presetIdx;
                    option.text = `Preset ${presetIdx + 1}`;
                    select.add(option);
                });

                select.value = select.options[0].value;
                document.getElementById('transmit-modal').classList.remove('hidden');
            } else if (labelsLoaded) {
                alert("Labels loaded and updated successfully.");
            } else {
                alert("Invalid File Format: No valid presets or labels found.");
            }
        } catch (err) {
            alert("Error reading file: Invalid JSON format.");
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

document.getElementById('btn-transmit-cancel').addEventListener('click', () => {
    document.getElementById('transmit-modal').classList.add('hidden');
    pendingBulkData = null;
});

document.getElementById('btn-transmit-confirm').addEventListener('click', () => {
    if (!pendingBulkData) return;

    const selection = document.getElementById('transmit-select').value;
    debugLog(`Transmit Bulk Dump confirmed. Target selection: ${selection === 'all' ? 'All Presets' : 'Preset ' + (parseInt(selection, 10) + 1)}`);

    if (selection === 'all') {
        sendBulkDumpTransmit(pendingBulkData);
    } else {
        const presetIndex = parseInt(selection, 10);
        if (isValidPresetArray(pendingBulkData[presetIndex])) {
            const singlePresetData = { [presetIndex]: pendingBulkData[presetIndex] };
            sendBulkDumpTransmit(singlePresetData);
        } else {
            alert("Error: This preset is empty or missing from the file.");
        }
    }

    document.getElementById('transmit-modal').classList.add('hidden');
    pendingBulkData = null;
});

// --- INITIALIZE APPLICATION ---
window.addEventListener('resize', resizeAndDrawAll);
startMidi();
// --- CONFIGURATION CONSTANTS ---
const CLOCK_INTERVAL_MS = 100; // Main monitoring clock interval (10 Hz)
const QUEUE_DELAY_MS = 90;     // Delay within the clock cycle to send queued commands
const TX_STAGGER_MS = 50;      // Stagger delay for transmitting presets to prevent buffer overflow
const DUMP_TIMEOUT_MS = 1000;  // Failsafe timeout for incomplete bulk dumps

// --- GLOBAL STATE VARIABLES ---
let midiAccess = null;
let midiInPort = null;
let midiOutPort = null;
let isDumpInProgress = false;

// Communication strategy variables
let isMonitoringActive = false;
let mainClockInterval = null;
let vcaUpdateMap = new Map(); // Merges values for the same fader before sending
let pendingCommands = [];     // Queue for Clear (0x01) and Preset (0x02) commands
let skipNextDisplay = false;  // Anti-collision flag for the MIDI bus

let isMultiSelectMode = false;
let selectedVCAs = []; 

// 2D Array storing the 64 fader values
const vcaLevels = Array.from({ length: 8 }, () => Array(8).fill(0));

// 2D Array storing the local edit state (true = edited locally [red], false = default [green])
const vcaEditedLocally = Array.from({ length: 8 }, () => Array(8).fill(false));

// Alyseum SysEx Header (Manufacturer ID + Device ID 0x0A)
const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x09, 0x0a];

// Buffer for storing incoming Bulk Dump presets
let dumpBuffer = {}; 
let dumpTimeout = null;

// ==========================================
// CORE MIDI OUTBOUND FUNCTIONS (IMMEDIATE)
// These functions send data physically to the MIDI port
// ==========================================

function sendClearAllVCAImmediate() {
    if (!midiOutPort) return;
    midiOutPort.send([...SYSEX_HEADER, 0x01, 0xf7]);
}

function sendSetPresetImmediate(presetNum) {
    if (!midiOutPort) return;
    const pt = Math.max(0, Math.min(15, presetNum));
    midiOutPort.send([...SYSEX_HEADER, 0x02, pt, 0xf7]);
}

function sendDisplayRequestImmediate() {
    if (!midiOutPort) return;
    midiOutPort.send([...SYSEX_HEADER, 0x03, 0xf7]);
}

function sendUpdateVCAsImmediate(vcaList) {
    if (!midiOutPort || vcaList.length === 0) return;
    const updates = vcaList.slice(0, 8); 
    const message = [...SYSEX_HEADER, 0x04];
    
    updates.forEach(vca => {
        message.push(Math.max(0, Math.min(63, vca.address)));
        message.push(Math.max(0, Math.min(127, vca.value)));
    });
    
    message.push(0xf7);
    midiOutPort.send(message);
}

// ==========================================
// QUEUEING FUNCTIONS (Called by UI)
// These functions store actions to be executed during the queue delay tick
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
        // ensuring only the last fader position is sent
        vcaUpdateMap.set(vca.address, vca.value);
    });
}

// Command 0x05: Request hardware to send a Bulk Dump to Editor (Bypasses 10Hz clock)
function sendDumpRequest() {
    if (!midiOutPort) return;
    
    isDumpInProgress = true;
    
    const rxButton = document.getElementById('btn-dump-rx');
    if (rxButton) {
        rxButton.disabled = true;
        rxButton.innerText = "Receiving... 0%";
    }
    
    midiOutPort.send([...SYSEX_HEADER, 0x05, 0xf7]);
}

// Command 0x06: Transmit Bulk Dump from Editor to overwrite hardware memory
function sendBulkDumpTransmit(bulkData) {
    if (!midiOutPort || !bulkData) return;
    
    isDumpInProgress = true;
    
    const txButton = document.getElementById('btn-dump-tx');
    if (txButton) {
        txButton.disabled = true;
        txButton.innerText = "Transmitting... 0%";
    }
    
    let presetsToTransmit = [];
    for (let i = 0; i < 16; i++) {
        if (bulkData[i] && bulkData[i].length === 64) {
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
        setTimeout(() => {
            const message = [...SYSEX_HEADER, 0x06, presetIdx];
            bulkData[presetIdx].forEach(val => message.push(Math.max(0, Math.min(127, val))));
            message.push(0xf7);
            
            midiOutPort.send(message);
            console.log(`Preset ${presetIdx} transmitted.`);
            
            completed++;
            if (txButton) {
                const percentage = Math.round((completed / total) * 100);
                txButton.innerText = `Transmitting... ${percentage}%`;
            }
            
            if (completed === total) {
                setTimeout(() => {
                    isDumpInProgress = false;
                    if (txButton) {
                        txButton.disabled = false;
                        txButton.innerText = "Transmit (load file to VCATRIX)";
                    }
                }, TX_STAGGER_MS);
            }
        }, index * TX_STAGGER_MS);
    });
}

// ==========================================
// MAIN CLOCK LOGIC
// ==========================================

function startMainClock() {
    if (mainClockInterval) clearInterval(mainClockInterval);
    
    mainClockInterval = setInterval(() => {
        if (isDumpInProgress) return; 

        // --- MAIN TICK (T = 0 ms) ---
        if (isMonitoringActive) {
            sendDisplayRequestImmediate();
        }

        // --- SECONDARY TICK (Delayed by QUEUE_DELAY_MS) ---
        setTimeout(() => {
            if (isDumpInProgress) return;

            // 1. Process global commands (Clear / Preset)
            if (pendingCommands.length > 0) {
                const lastCmd = pendingCommands[pendingCommands.length - 1];
                if (lastCmd.type === 'clear') {
                    sendClearAllVCAImmediate();
                } else if (lastCmd.type === 'preset') {
                    sendSetPresetImmediate(lastCmd.value);
                }
                pendingCommands = []; // Clean up
            }

            // 2. Process modified VCAs (Faders)
            if (vcaUpdateMap.size > 0) {
                const updates = Array.from(vcaUpdateMap.entries()).map(([address, value]) => ({address, value}));
                vcaUpdateMap.clear(); // Clean up
                
                for (let i = 0; i < updates.length; i += 8) {
                    const chunk = updates.slice(i, i + 8);
                    sendUpdateVCAsImmediate(chunk);
                }
            }
        }, QUEUE_DELAY_MS);

    }, CLOCK_INTERVAL_MS);
}

// ==========================================
// CORE MIDI INBOUND ROUTER
// ==========================================

function handleIncomingMidi(message) {
    const data = message.data;
    
    if (data.length < 6 || data[0] !== 0xf0 || data[1] !== 0x00 || data[2] !== 0x20 || data[3] !== 0x09) {
        return; 
    }
    if (data[4] !== 0x0a) return;

    const type = data[5];

    if (type === 0x10 || type === 0x41) {
        let index = 6;
        for (let inIdx = 0; inIdx < 8; inIdx++) {
            for (let outIdx = 0; outIdx < 8; outIdx++) {
                vcaLevels[outIdx][inIdx] = data[index];
                drawFader(`Conn_${inIdx}_${outIdx}`, data[index]);
                index++;
            }
        }
    } 
    else if (type === 0x11) {
        const presetNum = data[6];
        const dumpValues = [];
        for (let i = 7; i < 7 + 64; i++) dumpValues.push(data[i]);
        
        dumpBuffer[presetNum] = dumpValues;
        
        const rxButton = document.getElementById('btn-dump-rx');
        const receivedCount = Object.keys(dumpBuffer).length;
        if (rxButton) {
            const percentage = Math.round((receivedCount / 16) * 100);
            rxButton.innerText = `Receiving... ${percentage}%`;
        }

        if (dumpTimeout) clearTimeout(dumpTimeout);

        if (Object.keys(dumpBuffer).length === 16) {
            downloadBulkDumpFile(dumpBuffer);
            dumpBuffer = {}; 
            
            isDumpInProgress = false;
            
            if (rxButton) {
                rxButton.disabled = false;
                rxButton.innerText = "Receive (save to computer)";
            }
        } else {
            dumpTimeout = setTimeout(() => {
                console.warn("Timeout: Incomplete Dump received, saving partial file.");
                downloadBulkDumpFile(dumpBuffer);
                dumpBuffer = {};
                
                isDumpInProgress = false;
                
                if (rxButton) {
                    rxButton.disabled = false;
                    rxButton.innerText = "Receive (save to computer)";
                }
            }, DUMP_TIMEOUT_MS);
        }
    }
}

// ==========================================
// MIDI SETUP & CONNECTION
// ==========================================

async function startMidi() {
    try {
        midiAccess = await navigator.requestMIDIAccess({ sysex: true });
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
    const inSelect = document.getElementById('midi-in');
    const outSelect = document.getElementById('midi-out');
    const btnConnect = document.getElementById('btn-connect'); 
    
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

    if (currentIn) inSelect.value = currentIn;
    if (currentOut) outSelect.value = currentOut;

    const checkSelection = () => {
        btnConnect.disabled = (inSelect.value === "" || outSelect.value === "");
    };
    
    inSelect.addEventListener('change', checkSelection);
    outSelect.addEventListener('change', checkSelection);
}

function launchApp(isDemoMode) {
    document.getElementById('setup-header').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    generateMatrix();
    
    // Start the global clock when the editor interface is launched
    startMainClock();
    
    if (isDemoMode) {
        console.log("Started in DEMO Mode: MIDI transmission is disabled.");
    } else {
        console.log("MIDI Connection successfully established.");
    }
}

document.getElementById('btn-connect').addEventListener('click', () => {
    const inId = document.getElementById('midi-in').value;
    const outId = document.getElementById('midi-out').value;
    
    midiInPort = midiAccess.inputs.get(inId);
    midiOutPort = midiAccess.outputs.get(outId);
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
    const saved = localStorage.getItem('vcatrixLabels');
    return saved ? JSON.parse(saved) : {};
}

function SaveLabel(labelId, newValue) {
    const labels = getSavedLabels();
    labels[labelId] = newValue;
    localStorage.setItem('vcatrixLabels', JSON.stringify(labels));    
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
        const newValue = this.innerText.trim();
        SaveLabel(this.id, newValue);
    });
}

// ==========================================
// UI GENERATION & INTERACTION
// ==========================================

function generateMatrix() {
    const container = document.getElementById('matrix-container');
    container.innerHTML = '';
    const savedLabels = getSavedLabels();

    for (let row = 0; row <= 8; row++) {
        for (let col = 0; col <= 8; col++) {
            if (row === 0 && col === 0) {
                container.appendChild(document.createElement('div'));
            } else if (row === 0) {
                const label = document.createElement('div');
                label.id = `label-out-${col - 1}`;
                label.className = 'axis-label top';
                label.innerText = savedLabels[label.id] || `OUT ${col}`;
                makeHeaderEditable(label);
                container.appendChild(label);
            } else if (col === 0) {
                const label = document.createElement('div');
                label.id = `label-in-${row - 1}`;
                label.className = 'axis-label left';
                label.innerText = savedLabels[label.id] || `IN ${row}`;
                makeHeaderEditable(label);
                container.appendChild(label);
            } else {
                const inIdx = row - 1;
                const outIdx = col - 1;
                const faderDiv = document.createElement('div');
                faderDiv.className = 'fader-container';
                const canvas = document.createElement('canvas');
                canvas.id = `Conn_${inIdx}_${outIdx}`;
                canvas.width = 101;
                canvas.height = 101;
                
                faderDiv.appendChild(canvas);
                container.appendChild(faderDiv);
                drawFader(canvas.id, 0);
                setupCanvasInteraction(canvas, inIdx, outIdx);
            }
        }
    }
}

function drawFader(canvasId, value) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 101;
    const padding = 10;
    
    const parts = canvasId.split('_');
    const inI = parseInt(parts[1], 10);
    const outI = parseInt(parts[2], 10);
    const isEditedLocally = vcaEditedLocally[outI][inI];

    ctx.clearRect(0, 0, size, size);
    
    ctx.beginPath();
    ctx.moveTo(padding, size - padding);
    ctx.lineTo(size - padding, padding);
    ctx.strokeStyle = '#636563';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    const pos = value / 127;
    const x = padding + pos * (size - 2 * padding);
    const y = (size - padding) - pos * (size - 2 * padding);
    
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);
    ctx.fillStyle = isEditedLocally ? '#ff0000' : '#00ff00';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px Arial'; 
    ctx.textBaseline = 'middle';  
    ctx.fillText(value, size / 4, size / 4); 
}

function setupCanvasInteraction(canvas, inIdx, outIdx) {
    let isDragging = false;

    const calculateValue = (e) => {
        const rect = canvas.getBoundingClientRect();
        const diagonalPos = ((e.clientX - rect.left - 10) + (81 - (e.clientY - rect.top - 10))) / 2;
        let value = Math.round((diagonalPos / 81) * 127);
        return Math.max(0, Math.min(127, value));
    };

    const handleMovement = (e) => {
        const val = calculateValue(e);
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);
        
        if (isSelected && selectedVCAs.length > 0) {
            const updates = selectedVCAs.map(v => {
                vcaLevels[v.outIdx][v.inIdx] = val;
                vcaEditedLocally[v.outIdx][v.inIdx] = true; 
                drawFader(v.canvasId, val);
                return { address: v.inIdx + (8 * v.outIdx), value: val };
            });
            sendUpdateVCAs(updates); // Added to queue
        } else {
            vcaLevels[outIdx][inIdx] = val;
            vcaEditedLocally[outIdx][inIdx] = true; 
            drawFader(canvas.id, val);
            sendUpdateVCAs([{ address: inIdx + (8 * outIdx), value: val }]); // Added to queue
        }
    };

    canvas.addEventListener('mousedown', (e) => {
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
            isDragging = true;
            handleMovement(e);
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (isDragging && !isMultiSelectMode) handleMovement(e); 
    });

    window.addEventListener('mouseup', () => {
        isDragging = false; 
    });

    canvas.addEventListener('mouseenter', () => {
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);

        if (!isMultiSelectMode && isSelected && selectedVCAs.length > 0) {
            selectedVCAs.forEach(v => {
                const labelIn = document.getElementById(`label-in-${v.inIdx}`);
                const labelOut = document.getElementById(`label-out-${v.outIdx}`);
                if (labelIn) labelIn.classList.add('highlight');
                if (labelOut) labelOut.classList.add('highlight');
            });
        } else {
            const labelIn = document.getElementById(`label-in-${inIdx}`);
            const labelOut = document.getElementById(`label-out-${outIdx}`);
            if (labelIn) labelIn.classList.add('highlight');
            if (labelOut) labelOut.classList.add('highlight');
        }
    });

    canvas.addEventListener('mouseleave', () => {
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);

        if (!isMultiSelectMode && isSelected && selectedVCAs.length > 0) {
            selectedVCAs.forEach(v => {
                const labelIn = document.getElementById(`label-in-${v.inIdx}`);
                const labelOut = document.getElementById(`label-out-${v.outIdx}`);
                if (labelIn) labelIn.classList.remove('highlight');
                if (labelOut) labelOut.classList.remove('highlight');
            });
        } else {
            const labelIn = document.getElementById(`label-in-${inIdx}`);
            const labelOut = document.getElementById(`label-out-${outIdx}`);
            if (labelIn) labelIn.classList.remove('highlight');
            if (labelOut) labelOut.classList.remove('highlight');
        }
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
    e.target.innerText = isMultiSelectMode ? "Multi-Select: ON" : "Multi-Select: OFF";
    e.target.classList.toggle('active', isMultiSelectMode);
});

document.getElementById('btn-clear-selection').addEventListener('click', () => {
    selectedVCAs.forEach(v => document.getElementById(v.canvasId)?.parentElement.classList.remove('selected'));
    selectedVCAs = [];
    document.getElementById('btn-clear-selection').classList.add('hidden');
});

document.getElementById('btn-clear').addEventListener('click', () => {
    for (let inIdx = 0; inIdx < 8; inIdx++) {
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            vcaLevels[outIdx][inIdx] = 0;
            vcaEditedLocally[outIdx][inIdx] = false;
            drawFader(`Conn_${inIdx}_${outIdx}`, 0);
        }
    }
    sendClearAllVCA(); // Added to queue
});

document.getElementById('btn-monitor').addEventListener('click', (e) => {
    isMonitoringActive = !isMonitoringActive;
    
    if (!isMonitoringActive) {
        e.target.innerText = "Enable monitoring (10Hz)";
        e.target.style.backgroundColor = "#ff0000";
    } else {
        e.target.innerText = "Disable monitoring";
        e.target.style.backgroundColor = "#00aa00";
        sendDisplayRequestImmediate(); // Optional direct trigger for instant feedback
    }
});

document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        resetAllColorsToGreen();

        if (!midiOutPort) return;
        const presetNum = parseInt(e.target.getAttribute('data-preset'), 10);
        sendSetPreset(presetNum); // Added to queue
    });
});

document.getElementById('btn-dump-rx').addEventListener('click', () => {
    sendDumpRequest();
});

function downloadBulkDumpFile(bulkData) {
    bulkData.labels = getSavedLabels();
    const blob = new Blob([JSON.stringify(bulkData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date();
    const formattedDate = `${String(now.getDate()).padStart(2, '0')}_${String(now.getMonth() + 1).padStart(2, '0')}_${now.getFullYear()}`;
    a.href = url;
    a.download = `VCATRIX_BULK_${formattedDate}.vca`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// --- TRANSMIT MODAL LOGIC ---
let pendingBulkData = null;

document.getElementById('btn-dump-tx').addEventListener('click', () => {
    document.getElementById('file-upload').click();
});

document.getElementById('file-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const bulkData = JSON.parse(event.target.result);
            if (bulkData && typeof bulkData === 'object' && (bulkData[0] || bulkData.labels)) {
                if (bulkData.labels) {
                    localStorage.setItem('vcatrixLabels', JSON.stringify(bulkData.labels));
                    generateMatrix(); 
                }
                if (bulkData[0]) {
                    pendingBulkData = bulkData;
                    document.getElementById('transmit-select').value = "all"; 
                    document.getElementById('transmit-modal').classList.remove('hidden');
                }
            } else {
                alert("Invalid File Format.");
            }
        } catch (err) {
            alert("Error reading file.");
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
    
    if (selection === 'all') {
        sendBulkDumpTransmit(pendingBulkData);
    } else {
        const presetIndex = parseInt(selection, 10);
        if (pendingBulkData[presetIndex]) {
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
startMidi();
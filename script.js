// --- GLOBALS ---
let midiAccess = null;
let midiInPort = null;
let midiOutPort = null;
let monitoringInterval = null;

let isMultiSelectMode = false;
let selectedVCAs = []; 

const vcaLevels = Array.from({ length: 8 }, () => Array(8).fill(0));

// --- MIDI INIT ---
async function startMidi() {
    try {
        midiAccess = await navigator.requestMIDIAccess({ sysex: true });
        populateMidiSelects();
        midiAccess.onstatechange = populateMidiSelects;
    } catch (err) {
        console.error("MIDI access failed:", err);
        alert("Your browser does not support Web MIDI or you denied access.");
    }
}

function populateMidiSelects() {
    const inSelect = document.getElementById('midi-in');
    const outSelect = document.getElementById('midi-out');
    const btnConnect = document.getElementById('btn-connect');
    
    inSelect.innerHTML = '<option value="">Select...</option>';
    outSelect.innerHTML = '<option value="">Select...</option>';

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

    const checkSelection = () => {
        btnConnect.disabled = (inSelect.value === "" || outSelect.value === "");
    };
    inSelect.addEventListener('change', checkSelection);
    outSelect.addEventListener('change', checkSelection);
}

// --- CONNECT ---
document.getElementById('btn-connect').addEventListener('click', () => {
    const inId = document.getElementById('midi-in').value;
    const outId = document.getElementById('midi-out').value;

    midiInPort = midiAccess.inputs.get(inId);
    midiOutPort = midiAccess.outputs.get(outId);

    midiInPort.onmidimessage = handleMidiMessage;

    document.getElementById('setup-header').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    
    generateMatrix();
});

// --- RX MIDI ---
function handleMidiMessage(message) {
    const data = message.data;
    if (data.length >= 6 && data[0] === 0xf0 && data[4] === 0x0a && data[5] === 0x41) {
        let n = 6;
        for (let inIdx = 0; inIdx < 8; inIdx++) {
            for (let outIdx = 0; outIdx < 8; outIdx++) {
                vcaLevels[outIdx][inIdx] = data[n];
                drawFader(`Conn_${inIdx}_${outIdx}`, data[n]);
                n++;
            }
        }
    }
}

// --- TX MIDI (SINGLE) ---
function updateVCA(inIdx, outIdx, value) {
    if (!midiOutPort) return;
    value = Math.max(0, Math.min(127, value));
    vcaLevels[outIdx][inIdx] = value;
    
    const vcaAddress = inIdx + (8 * outIdx);
    const message = [0xf0, 0x00, 0x20, 0x09, 0x0a, 0x04, vcaAddress, value, 0xf7];
    midiOutPort.send(message);
}

// --- TX MIDI (GROUPED) ---
function updateMultipleVCAs(value) {
    if (!midiOutPort || selectedVCAs.length === 0) return;
    value = Math.max(0, Math.min(127, value));
    
    const message = [0xf0, 0x00, 0x20, 0x09, 0x0a, 0x04];
    
    selectedVCAs.forEach(vca => {
        vcaLevels[vca.outIdx][vca.inIdx] = value;
        drawFader(vca.canvasId, value);
        
        const vcaAddress = vca.inIdx + (8 * vca.outIdx);
        message.push(vcaAddress);
        message.push(value);
    });
    
    message.push(0xf7);
    midiOutPort.send(message);
}

// --- GENERATE MATRIX (9x9 with Axes) ---
function generateMatrix() {
    const container = document.getElementById('matrix-container');
    container.innerHTML = ''; 

    // Loop through 9 rows and 9 columns
    for (let row = 0; row <= 8; row++) {
        for (let col = 0; col <= 8; col++) {
            
            if (row === 0 && col === 0) {
                // Top-Left empty corner
                const corner = document.createElement('div');
                container.appendChild(corner);
            } 
            else if (row === 0) {
                // Top Axis (OUT)
                const label = document.createElement('div');
                label.className = 'axis-label top';
                label.innerText = `OUT ${col}`;
                container.appendChild(label);
            } 
            else if (col === 0) {
                // Left Axis (IN)
                const label = document.createElement('div');
                label.className = 'axis-label left';
                label.innerText = `IN ${row}`;
                container.appendChild(label);
            } 
            else {
                // Faders (Grid coordinates mapped to 0-7 indexes)
                const inIdx = row - 1;
                const outIdx = col - 1;

                const faderDiv = document.createElement('div');
                faderDiv.className = 'fader-container';
                
                const canvas = document.createElement('canvas');
                canvas.id = `Conn_${inIdx}_${outIdx}`;
                canvas.width = 91;
                canvas.height = 91;
                
                faderDiv.appendChild(canvas);
                container.appendChild(faderDiv);

                drawFader(canvas.id, 0);
                setupCanvasInteraction(canvas, inIdx, outIdx);
            }
        }
    }
}

// --- DRAW FADER ---
function drawFader(canvasId, value) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 91;
    const padding = 5;
    
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
    ctx.fillStyle = '#00ff00';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    ctx.fillStyle = '#ffffff';
    ctx.font = '10px Arial';
    ctx.fillText(value, 5, 12);
}

// --- FADER INTERACTION ---
function setupCanvasInteraction(canvas, inIdx, outIdx) {
    let isDragging = false;

    const calculateValue = (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const size = 91;
        const padding = 5;
        
        const adjustedX = x - padding;
        const adjustedY = y - padding;
        const effectiveSize = size - 2 * padding;
        
        const diagonalPos = (adjustedX + (effectiveSize - adjustedY)) / 2;
        let value = Math.round((diagonalPos / effectiveSize) * 127);
        return Math.max(0, Math.min(127, value));
    };

    const handleMovement = (e) => {
        const val = calculateValue(e);
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);
        
        if (isSelected && selectedVCAs.length > 0) {
            updateMultipleVCAs(val);
        } else {
            drawFader(canvas.id, val);
            updateVCA(inIdx, outIdx, val); 
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
}

// --- SIDEBAR EVENTS ---

document.getElementById('btn-multi-select').addEventListener('click', (e) => {
    isMultiSelectMode = !isMultiSelectMode;
    e.target.innerText = isMultiSelectMode ? "Multi-Select: ON" : "Multi-Select: OFF";
    e.target.classList.toggle('active', isMultiSelectMode);
});

document.getElementById('btn-clear-selection').addEventListener('click', () => {
    selectedVCAs.forEach(vca => {
        const canvas = document.getElementById(vca.canvasId);
        if (canvas) canvas.parentElement.classList.remove('selected');
    });
    selectedVCAs = [];
    document.getElementById('btn-clear-selection').classList.add('hidden');
});

document.getElementById('btn-clear').addEventListener('click', () => {
    if (!midiOutPort) return;
    
    for (let inIdx = 0; inIdx < 8; inIdx++) {
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            vcaLevels[outIdx][inIdx] = 0;
            drawFader(`Conn_${inIdx}_${outIdx}`, 0);
        }
    }

    const message = [0xf0, 0x00, 0x20, 0x09, 0x0a, 0x06];
    for (let i = 0; i < 64; i++) message.push(0x00);
    message.push(0xf7);
    
    midiOutPort.send(message);
});

document.getElementById('btn-monitor').addEventListener('click', (e) => {
    if (!midiOutPort) return;
    
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        e.target.innerText = "Enable Monitoring (10Hz)";
        e.target.style.backgroundColor = "#ff0000";
    } else {
        monitoringInterval = setInterval(() => {
            midiOutPort.send([0xf0, 0x00, 0x20, 0x09, 0x0a, 0x03, 0xf7]);
        }, 100);
        e.target.innerText = "Disable Monitoring";
        e.target.style.backgroundColor = "#00aa00";
    }
});

document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (!midiOutPort) return;
        const presetNum = parseInt(e.target.getAttribute('data-preset'), 10);
        midiOutPort.send([0xf0, 0x00, 0x20, 0x09, 0x02, presetNum, 0xf7]);
        setTimeout(() => {
            midiOutPort.send([0xf0, 0x00, 0x20, 0x09, 0x0a, 0x03, 0xf7]); 
        }, 50);
    });
});

// --- BOOT ---
startMidi();
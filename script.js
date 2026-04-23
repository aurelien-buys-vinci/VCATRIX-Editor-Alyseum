// --- GLOBAL STATE VARIABLES ---
let midiAccess = null;
let midiInPort = null;
let midiOutPort = null;
let monitoringInterval = null;

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
// 1. CORE MIDI OUTBOUND FUNCTIONS
// ==========================================

// Command 0x01: Clear all hardware VCAs
function sendClearAllVCA() {
    if (!midiOutPort) return;
    midiOutPort.send([...SYSEX_HEADER, 0x01, 0xf7]);
}

// Command 0x02: Load hardware preset
function sendSetPreset(presetNum) {
    if (!midiOutPort) return;
    const pt = Math.max(0, Math.min(15, presetNum));
    midiOutPort.send([...SYSEX_HEADER, 0x02, pt, 0xf7]);
}

// Command 0x03: Request hardware to send current VCA values
function sendDisplayRequest() {
    if (!midiOutPort) return;
    midiOutPort.send([...SYSEX_HEADER, 0x03, 0xf7]);
}

// Command 0x04: Update specific VCA values (up to 8 per message)
function sendUpdateVCAs(vcaList) {
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

// Command 0x05: Request hardware to send a Bulk Dump to Editor
function sendDumpRequest() {
    if (!midiOutPort) return;
    midiOutPort.send([...SYSEX_HEADER, 0x05, 0xf7]);
}

// Command 0x06: Transmit Bulk Dump from Editor to overwrite hardware memory
function sendBulkDumpTransmit(bulkData) {
    if (!midiOutPort || !bulkData) return;
    
    for (let i = 0; i < 16; i++) {
        if (bulkData[i] && bulkData[i].length === 64) {
            const message = [...SYSEX_HEADER, 0x06, i];
            bulkData[i].forEach(val => message.push(Math.max(0, Math.min(127, val))));
            message.push(0xf7);
            
            // Stagger transmission to prevent MIDI buffer overflow
            setTimeout(() => {
                midiOutPort.send(message);
                console.log(`Preset ${i} transmitted.`);
            }, i * 20);
        }
    }
}

// ==========================================
// 2. CORE MIDI INBOUND ROUTER
// ==========================================

function handleIncomingMidi(message) {
    const data = message.data;
    
    // Verify SysEx header length and manufacturer match
    if (data.length < 6 || data[0] !== 0xf0 || data[1] !== 0x00 || data[2] !== 0x20 || data[3] !== 0x09) {
        return; 
    }

    // Verify Device ID matches VCATRIX (0x0A)
    if (data[4] !== 0x0a) return;

    const type = data[5];

    // Handle incoming Monitoring Data (Command 0x10 or alternative 0x41)
    if (type === 0x10 || type === 0x41) {
        let index = 6;
        for (let inIdx = 0; inIdx < 8; inIdx++) {
            for (let outIdx = 0; outIdx < 8; outIdx++) {
                vcaLevels[outIdx][inIdx] = data[index];
                // Draw fader with new value (retains its current red/green color state)
                drawFader(`Conn_${inIdx}_${outIdx}`, data[index]);
                index++;
            }
        }
    } 
    // Handle incoming Bulk Dump Data (Command 0x11)
    else if (type === 0x11) {
        const presetNum = data[6];
        const dumpValues = [];
        for (let i = 7; i < 7 + 64; i++) dumpValues.push(data[i]);
        
        // Store received preset in buffer
        dumpBuffer[presetNum] = dumpValues;
        
        if (dumpTimeout) clearTimeout(dumpTimeout);

        // Download file if all 16 presets are received
        if (Object.keys(dumpBuffer).length === 16) {
            downloadBulkDumpFile(dumpBuffer);
            dumpBuffer = {}; 
        } else {
            // Failsafe: Download partial dump if connection drops during transmission
            dumpTimeout = setTimeout(() => {
                console.warn("Timeout: Incomplete Dump received, saving partial file.");
                downloadBulkDumpFile(dumpBuffer);
                dumpBuffer = {};
            }, 1000);
        }
    }
}


// ==========================================
// 3. MIDI SETUP & CONNECTION
// ==========================================

// Request MIDI access from browser
async function startMidi() {
    try {
        midiAccess = await navigator.requestMIDIAccess({ sysex: true });
        populateMidiSelects();
        midiAccess.onstatechange = populateMidiSelects;
    } catch (err) {
        console.error("MIDI access failed:", err);
    }
}

// Populate HTML dropdowns with available MIDI devices
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

    // Enable Connect button only when both ports are selected
    const checkSelection = () => {
        btnConnect.disabled = (inSelect.value === "" || outSelect.value === "");
    };
    
    inSelect.addEventListener('change', checkSelection);
    outSelect.addEventListener('change', checkSelection);
}

// Utility to switch from Setup screen to Editor Interface
function launchApp(isDemoMode) {
    document.getElementById('setup-header').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    generateMatrix();
    
    if (isDemoMode) {
        console.log("Started in DEMO Mode: MIDI transmission is disabled.");
    } else {
        console.log("MIDI Connection successfully established.");
    }
}

// Handle Connect button click
document.getElementById('btn-connect').addEventListener('click', () => {
    const inId = document.getElementById('midi-in').value;
    const outId = document.getElementById('midi-out').value;
    
    midiInPort = midiAccess.inputs.get(inId);
    midiOutPort = midiAccess.outputs.get(outId);
    midiInPort.onmidimessage = handleIncomingMidi;
    
    launchApp(false);
});

// Handle DEMO button click
document.getElementById('btn-demo').addEventListener('click', () => {
    midiInPort = null;
    midiOutPort = null;
    launchApp(true);
});


// ==========================================
// 4. UI GENERATION & INTERACTION
// ==========================================

// Build the 9x9 HTML grid including IN/OUT axis labels
function generateMatrix() {
    const container = document.getElementById('matrix-container');
    container.innerHTML = ''; 

    for (let row = 0; row <= 8; row++) {
        for (let col = 0; col <= 8; col++) {
            if (row === 0 && col === 0) {
                container.appendChild(document.createElement('div'));
            } else if (row === 0) {
                const label = document.createElement('div');
                label.id = `label-out-${col - 1}`;
                label.className = 'axis-label top';
                label.innerText = `OUT ${col}`;
                container.appendChild(label);
            } else if (col === 0) {
                const label = document.createElement('div');
                label.id = `label-in-${row - 1}`;
                label.className = 'axis-label left';
                label.innerText = `IN ${row}`;
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

// Render the graphical fader onto the HTML canvas element
function drawFader(canvasId, value) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 101;
    const padding = 10;
    
    // Extract matrix indices from the canvas ID to check local edit state
    const parts = canvasId.split('_');
    const inI = parseInt(parts[1], 10);
    const outI = parseInt(parts[2], 10);
    const isEditedLocally = vcaEditedLocally[outI][inI];

    ctx.clearRect(0, 0, size, size);
    
    // Draw diagonal track
    ctx.beginPath();
    ctx.moveTo(padding, size - padding);
    ctx.lineTo(size - padding, padding);
    ctx.strokeStyle = '#636563';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Calculate cursor position
    const pos = value / 127;
    const x = padding + pos * (size - 2 * padding);
    const y = (size - padding) - pos * (size - 2 * padding);
    
    // Draw cursor dot
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, 2 * Math.PI);
    // Fill color: Red if edited by user, Green if default/untouched
    ctx.fillStyle = isEditedLocally ? '#ff0000' : '#00ff00';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.stroke();
    
    // Draw centered value text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px Arial'; 
    ctx.textBaseline = 'middle';  
    ctx.fillText(value, size / 4, size / 4); 
}

// Handle mouse events on canvas to adjust VCA values
function setupCanvasInteraction(canvas, inIdx, outIdx) {
    let isDragging = false;

    // Convert mouse coordinates to a 0-127 scale value
    const calculateValue = (e) => {
        const rect = canvas.getBoundingClientRect();
        const diagonalPos = ((e.clientX - rect.left - 10) + (81 - (e.clientY - rect.top - 10))) / 2;
        let value = Math.round((diagonalPos / 81) * 127);
        return Math.max(0, Math.min(127, value));
    };

    // Update visuals and send MIDI data based on mouse movement
    const handleMovement = (e) => {
        const val = calculateValue(e);
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);
        
        if (isSelected && selectedVCAs.length > 0) {
            // Multi-VCA update
            const updates = selectedVCAs.map(v => {
                vcaLevels[v.outIdx][v.inIdx] = val;
                vcaEditedLocally[v.outIdx][v.inIdx] = true; // Mark as edited
                drawFader(v.canvasId, val);
                return { address: v.inIdx + (8 * v.outIdx), value: val };
            });
            sendUpdateVCAs(updates); 
        } else {
            // Single-VCA update
            vcaLevels[outIdx][inIdx] = val;
            vcaEditedLocally[outIdx][inIdx] = true; // Mark as edited
            drawFader(canvas.id, val);
            sendUpdateVCAs([{ address: inIdx + (8 * outIdx), value: val }]);
        }
    };

    canvas.addEventListener('mousedown', (e) => {
        if (isMultiSelectMode) {
            // Toggle selection state for the clicked canvas
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
            // Show/Hide the Clear Selection button
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


    // Highlight corresponding labels on hover, with special handling for multi-selected VCAs 
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

    // Remove label highlights on mouse leave, with special handling for multi-selected VCAs
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

// Utility function to revert all local edit states to green
function resetAllColorsToGreen() {
    for (let inIdx = 0; inIdx < 8; inIdx++) {
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            vcaEditedLocally[outIdx][inIdx] = false;
            drawFader(`Conn_${inIdx}_${outIdx}`, vcaLevels[outIdx][inIdx]);
        }
    }
}


// ==========================================
// 5. SIDEBAR EVENT LISTENERS & MODALS
// ==========================================

// Toggle Group Mode
document.getElementById('btn-multi-select').addEventListener('click', (e) => {
    isMultiSelectMode = !isMultiSelectMode;
    e.target.innerText = isMultiSelectMode ? "Multi-Select: ON" : "Multi-Select: OFF";
    e.target.classList.toggle('active', isMultiSelectMode);
});

// Clear current canvas selection
document.getElementById('btn-clear-selection').addEventListener('click', () => {
    selectedVCAs.forEach(v => document.getElementById(v.canvasId)?.parentElement.classList.remove('selected'));
    selectedVCAs = [];
    document.getElementById('btn-clear-selection').classList.add('hidden');
});

// Reset all values to zero and clear local edit states
document.getElementById('btn-clear').addEventListener('click', () => {
    for (let inIdx = 0; inIdx < 8; inIdx++) {
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            vcaLevels[outIdx][inIdx] = 0;
            vcaEditedLocally[outIdx][inIdx] = false;
            drawFader(`Conn_${inIdx}_${outIdx}`, 0);
        }
    }
    sendClearAllVCA();
});

// Toggle 10Hz continuous hardware monitoring
document.getElementById('btn-monitor').addEventListener('click', (e) => {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        e.target.innerText = "Enable monitoring (10Hz)";
        e.target.style.backgroundColor = "#ff0000";
    } else {
        monitoringInterval = setInterval(sendDisplayRequest, 100);
        e.target.innerText = "Disable monitoring";
        e.target.style.backgroundColor = "#00aa00";
    }
});

// Load specific hardware preset and reset local edit states
document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', (e) => {
        document.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        resetAllColorsToGreen();

        if (!midiOutPort) return;
        const presetNum = parseInt(e.target.getAttribute('data-preset'), 10);
        sendSetPreset(presetNum);
        
        setTimeout(sendDisplayRequest, 50);
    });
});

// Trigger hardware dump request
document.getElementById('btn-dump-rx').addEventListener('click', () => {
    sendDumpRequest();
});

// Generate and download a JSON file containing the Bulk Dump data
function downloadBulkDumpFile(bulkData) {
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

// Temporary storage for file data before user confirmation
let pendingBulkData = null;

// Open file selector to load dump file
document.getElementById('btn-dump-tx').addEventListener('click', () => {
    document.getElementById('file-upload').click();
});

// Intercept file loading, store data, and show Modal
document.getElementById('file-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const bulkData = JSON.parse(event.target.result);
            if (bulkData && typeof bulkData === 'object' && bulkData[0]) {
                // Store data and show modal instead of sending immediately
                pendingBulkData = bulkData;
                document.getElementById('transmit-select').value = "all"; // Reset to default
                document.getElementById('transmit-modal').classList.remove('hidden');
            } else {
                alert("Invalid File Format.");
            }
        } catch (err) {
            alert("Error reading file.");
        }
    };
    reader.readAsText(file);
    
    // Clear the input value so the exact same file can trigger 'change' again if needed
    e.target.value = '';
});

// Modal Cancel Button: Hide modal and clear pending data
document.getElementById('btn-transmit-cancel').addEventListener('click', () => {
    document.getElementById('transmit-modal').classList.add('hidden');
    pendingBulkData = null;
});

// Modal Confirm Button: Send All or specific preset based on dropdown choice
document.getElementById('btn-transmit-confirm').addEventListener('click', () => {
    if (!pendingBulkData) return;
    
    const selection = document.getElementById('transmit-select').value;
    
    if (selection === 'all') {
        // Send all 16 presets
        sendBulkDumpTransmit(pendingBulkData);
        alert("Bulk Dump (All 16 Presets) Transmitted Successfully!");
    } else {
        // Send only the selected preset
        const presetIndex = parseInt(selection, 10);
        if (pendingBulkData[presetIndex]) {
            // Create a temporary object containing ONLY the selected preset
            const singlePresetData = { [presetIndex]: pendingBulkData[presetIndex] };
            sendBulkDumpTransmit(singlePresetData);
            alert(`Preset ${presetIndex + 1} Transmitted Successfully!`);
        } else {
            alert("Error: This preset is empty or missing from the file.");
        }
    }
    
    // Hide modal and cleanup
    document.getElementById('transmit-modal').classList.add('hidden');
    pendingBulkData = null;
});

function testerReceptionDump() {
    console.log("Simulation : Réception du Bulk Dump (16 presets)...");
    
    // La boucle des presets va explicitement de 0x00 à 0x0F (0 à 15)
    for (let p = 0x00; p <= 0x0F; p++) {
        const fakeMessage = [0xf0, 0x00, 0x20, 0x09, 0x0a, 0x11, p];
        
        // 64 valeurs par preset (strictement entre 0x00 et 0x7F)
        for (let i = 0; i < 64; i++) {
            // On crée un motif qui change en fonction du preset 'p'
            // Le modulo 128 (% 128) garantit que la valeur ne dépassera jamais 127 (7F)
            let fakeValue = (i * 2 + (p * 5)) % 128; 
            fakeMessage.push(fakeValue);
        }
        
        fakeMessage.push(0xf7); // Fin du message SysEx
        
        // On simule l'arrivée successive des 16 messages avec 10ms d'écart
        setTimeout(() => {
            handleIncomingMidi({ data: fakeMessage });
            console.log(`Simulation : Preset ${p} reçu.`);
        }, p * 10);
    }
}

// --- INITIALIZE APPLICATION ---
startMidi();
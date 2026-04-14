// --- GLOBALS ---
let midiAccess = null;
let midiInPort = null;
let midiOutPort = null;
let monitoringInterval = null;

let isMultiSelectMode = false;
let selectedVCAs = []; 
const vcaLevels = Array.from({ length: 8 }, () => Array(8).fill(0));

let dumpBuffer = {}; 
let dumpTimeout = null;

const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x09, 0x0a];

// ==========================================
// 1. CORE MIDI FUNCTIONS (THE 8 COMMANDS)
// ==========================================

// TX 1: CLEAR all VCA (La commande est 0x01)
function sendClearAllVCA() {
    if (!midiOutPort) return;
    midiOutPort.send([...SYSEX_HEADER, 0x01, 0xf7]);
}

// TX 2: SET preset (La commande est 0x02)
function sendSetPreset(presetNum) {
    if (!midiOutPort) return;
    const pt = Math.max(0, Math.min(15, presetNum));
    midiOutPort.send([...SYSEX_HEADER, 0x02, pt, 0xf7]);
}

// TX 3: DISPLAY Request (La commande est 0x03)
function sendDisplayRequest() {
    if (!midiOutPort) return;
    midiOutPort.send([...SYSEX_HEADER, 0x03, 0xf7]);
}

// TX 4: UPDATE upto 8 VCA Value (La commande est 0x04)
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

// TX 5: DUMP request (La commande est 0x05)
function sendDumpRequest() {
    if (!midiOutPort) return;
    midiOutPort.send([...SYSEX_HEADER, 0x05, 0xf7]);
}

// TX 6: DUMP Transmit (LOAD BULK to VCATRIX)
// bulkData doit être un objet contenant les 16 presets : { 0: [...], 1: [...], ..., 15: [...] }
function sendBulkDumpTransmit(bulkData) {
    if (!midiOutPort || !bulkData) return;
    
    for (let i = 0; i < 16; i++) {
        if (bulkData[i] && bulkData[i].length === 64) {
            const message = [...SYSEX_HEADER, 0x06, i];
            bulkData[i].forEach(val => message.push(Math.max(0, Math.min(127, val))));
            message.push(0xf7);
            
            // On espace les 16 envois de 20 millisecondes chacun
            setTimeout(() => {
                midiOutPort.send(message);
                console.log(`Preset ${i} envoyé !`);
            }, i * 20);
        }
    }
}

/**
 * Fonction de réception mise à jour
 * Vérifie le Device ID à l'index 4 et la commande à l'index 5
 */
function handleIncomingMidi(message) {
    const data = message.data;
    
    // 1. Vérification stricte de l'en-tête Alyseum (Index 0 à 4)
    if (data.length < 6 || data[0] !== 0xf0 || data[1] !== 0x00 || data[2] !== 0x20 || data[3] !== 0x09 || data[4] !== 0x0a) {
        return; 
    }

    // 3. Identification de la commande (Index 5) 
    const type = data[5];

    // Commande 0x10 ou 0x41 : Réception des 64 valeurs (Monitoring) 
    if (type === 0x10) {
        let index = 6; // Les données commencent après la commande
        for (let inIdx = 0; inIdx < 8; inIdx++) {
            for (let outIdx = 0; outIdx < 8; outIdx++) {
                vcaLevels[outIdx][inIdx] = data[index];
                drawFader(`Conn_${inIdx}_${outIdx}`, data[index]);
                index++;
            }
        }
    } 
    // RX 2: DUMP Receive (Commande 0x11)
    else if (type === 0x11) {
        const presetNum = data[6];
        const dumpValues = [];
        for (let i = 7; i < 7 + 64; i++) {
            dumpValues.push(data[i]);
        }
        
        // 1. On stocke le preset reçu dans notre "salle d'attente"
        dumpBuffer[presetNum] = dumpValues;
        
        // 2. On annule le timer de sécurité s'il existait
        if (dumpTimeout) clearTimeout(dumpTimeout);

        // 3. On vérifie si on a bien reçu les 16 presets (de 0 à 15)
        if (Object.keys(dumpBuffer).length === 16) {
            console.log("Les 16 presets ont été reçus avec succès !");
            downloadBulkDumpFile(dumpBuffer);
            dumpBuffer = {}; // On vide le buffer pour la prochaine fois
        } else {
            // Sécurité : Si un message se perd en route, on télécharge quand même
            // ce qu'on a reçu au bout d'1 seconde d'inactivité.
            dumpTimeout = setTimeout(() => {
                console.warn("Temps écoulé : Dump incomplet, sauvegarde partielle.");
                downloadBulkDumpFile(dumpBuffer);
                dumpBuffer = {};
            }, 1000);
        }
    }
}

// ==========================================
// 2. MIDI SETUP & CONNECTION
// ==========================================

async function startMidi() {
    try {
        midiAccess = await navigator.requestMIDIAccess({ sysex: true });
        populateMidiSelects();
        midiAccess.onstatechange = populateMidiSelects;
    } catch (err) {
        console.error("MIDI access failed:", err);
        alert("Web MIDI is not supported or access was denied.");
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

    const checkSelection = () => btnConnect.disabled = (inSelect.value === "" || outSelect.value === "");
    inSelect.addEventListener('change', checkSelection);
    outSelect.addEventListener('change', checkSelection);
}

document.getElementById('btn-connect').addEventListener('click', () => {
    midiInPort = midiAccess.inputs.get(document.getElementById('midi-in').value);
    midiOutPort = midiAccess.outputs.get(document.getElementById('midi-out').value);
    
    // Assign the router to incoming messages
    midiInPort.onmidimessage = handleIncomingMidi;

    document.getElementById('setup-header').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    generateMatrix();
});


// ==========================================
// 3. UI GENERATION & INTERACTION
// ==========================================

function generateMatrix() {
    const container = document.getElementById('matrix-container');
    container.innerHTML = ''; 

    for (let row = 0; row <= 8; row++) {
        for (let col = 0; col <= 8; col++) {
            if (row === 0 && col === 0) {
                container.appendChild(document.createElement('div'));
            } else if (row === 0) {
                const label = document.createElement('div');
                label.className = 'axis-label top';
                label.innerText = `OUT ${col}`;
                container.appendChild(label);
            } else if (col === 0) {
                const label = document.createElement('div');
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

function drawFader(canvasId, value) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 101;
    const padding = 10;
    
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

function setupCanvasInteraction(canvas, inIdx, outIdx) {
    let isDragging = false;
    let currentDraggedValue = 0; // On stocke la valeur pendant le mouvement

    const calculateValue = (e) => {
        const rect = canvas.getBoundingClientRect();
        // On a 10px de padding, et la taille active de la barre est de 81px (101 - 2*10)
        const diagonalPos = ((e.clientX - rect.left - 10) + (81 - (e.clientY - rect.top - 10))) / 2;
        let value = Math.round((diagonalPos / 81) * 127);
        return Math.max(0, Math.min(127, value));
    };

    // 1. Fonction pour l'AFFICHAGE (exécutée en continu)
    const handleVisualMovement = (e) => {
        currentDraggedValue = calculateValue(e);
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);
        
        if (isSelected && selectedVCAs.length > 0) {
            // Mettre à jour tous les faders sélectionnés visuellement
            selectedVCAs.forEach(v => {
                vcaLevels[v.outIdx][v.inIdx] = currentDraggedValue;
                drawFader(v.canvasId, currentDraggedValue);
            });
        } else {
            // Mettre à jour un seul fader visuellement
            vcaLevels[outIdx][inIdx] = currentDraggedValue;
            drawFader(canvas.id, currentDraggedValue);
        }
    };

    // 2. Fonction pour l'ENVOI MIDI (exécutée uniquement à la fin)
    const sendMidiData = () => {
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);
        
        if (isSelected && selectedVCAs.length > 0) {
            const updates = selectedVCAs.map(v => {
                return { address: v.inIdx + (8 * v.outIdx), value: currentDraggedValue };
            });
            sendUpdateVCAs(updates);
            sendDisplayRequest();
        } else {
            sendUpdateVCAs([{ address: inIdx + (8 * outIdx), value: currentDraggedValue }]);
            sendDisplayRequest();
        }
    };

    canvas.addEventListener('mousedown', (e) => {
        if (isMultiSelectMode) {
            // Logique de sélection (inchangée)
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
            // Début du glissement
            isDragging = true;
            handleVisualMovement(e); // Met à jour le visuel au clic
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (isDragging && !isMultiSelectMode) {
            handleVisualMovement(e); // Met à jour le visuel pendant le mouvement
        }
    });

    window.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            sendMidiData(); // <-- C'est ici qu'on envoie le MIDI enfin !
        }
    });
}


// ==========================================
// 4. SIDEBAR EVENT LISTENERS
// ==========================================

// Group Mode
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

// Clear All VCA
document.getElementById('btn-clear').addEventListener('click', () => {
    // Local visual reset
    for (let inIdx = 0; inIdx < 8; inIdx++) {
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            vcaLevels[outIdx][inIdx] = 0;
            drawFader(`Conn_${inIdx}_${outIdx}`, 0);
        }
    }
    sendClearAllVCA();
});

// Monitoring (10Hz)
document.getElementById('btn-monitor').addEventListener('click', (e) => {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        e.target.innerText = "Enable Monitoring (10Hz)";
        e.target.style.backgroundColor = "#ff0000";
    } else {
        monitoringInterval = setInterval(sendDisplayRequest, 100);
        e.target.innerText = "Disable Monitoring";
        e.target.style.backgroundColor = "#00aa00";
    }
});

// Presets (1-16)
document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const presetNum = parseInt(e.target.getAttribute('data-preset'), 10);
        sendSetPreset(presetNum);
        // Ask for visual update shortly after
        setTimeout(sendDisplayRequest, 50);
    });
});

// Dump Actions
document.getElementById('btn-dump-rx').addEventListener('click', () => {
    sendDumpRequest();
});

document.getElementById('btn-dump-tx').addEventListener('click', () => {
    // Ouvre la boite de dialogue pour choisir le fichier sur le Mac
    document.getElementById('file-upload').click();
});

document.getElementById('file-upload').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const bulkData = JSON.parse(event.target.result);
            // On vérifie grossièrement que c'est un Bulk (présence de multiples presets)
            if (bulkData && typeof bulkData === 'object' && bulkData[0]) {
                sendBulkDumpTransmit(bulkData);
                alert("Bulk Dump (16 Presets) Transmitted Successfully!");
            } else {
                alert("Format de fichier invalide.");
            }
        } catch (err) {
            alert("Erreur de lecture du fichier.");
        }
    };
    reader.readAsText(file);
});

function downloadBulkDumpFile(bulkData) {
    const blob = new Blob([JSON.stringify(bulkData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VCATRIX_BULK_16_Presets.vca`; // Un seul fichier !
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ==========================================
// 5. MODE SIMULATION (POUR TESTER SANS LA CARTE)
// ==========================================

// Simule la réception d'un Monitoring (10Hz) avec des valeurs aléatoires
function testerReceptionMonitoring() {
    console.log("Simulation : Réception d'un monitoring...");
    const fakeMessage = [0xf0, 0x00, 0x20, 0x09, 0x0a, 0x10]; // En-tête + Commande 10
    
    // On génère 64 valeurs au hasard (entre 0 et 127)
    for (let i = 0; i < 64; i++) {
        fakeMessage.push(Math.floor(Math.random() * 128));
    }
    
    fakeMessage.push(0xf7); // Fin du message
    
    // On fait croire à notre code que ça vient du MIDI
    handleIncomingMidi({ data: fakeMessage });
}

// Simule la réception d'un Bulk Dump COMPLET (16 presets) avec données valides
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

// --- BOOT ---
startMidi();
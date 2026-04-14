// --- VARIABLES GLOBALES ---
let midiAccess = null;
let midiInPort = null;
let midiOutPort = null;
let monitoringInterval = null;
let isMultiSelectMode = false;
let selectedVCAs = []; // Va stocker les faders sélectionnés : {inIdx, outIdx, canvasId}

const vcaLevels = Array.from({ length: 8 }, () => Array(8).fill(0));

// --- INITIALISATION DU MIDI ---
async function startMidi() {
    try {
        midiAccess = await navigator.requestMIDIAccess({ sysex: true });
        populateMidiSelects();
        midiAccess.onstatechange = populateMidiSelects;
    } catch (err) {
        console.error("Échec de l'accès au MIDI :", err);
        alert("Votre navigateur ne supporte pas le Web MIDI ou vous avez refusé l'accès.");
    }
}

function populateMidiSelects() {
    const inSelect = document.getElementById('midi-in');
    const outSelect = document.getElementById('midi-out');
    const btnConnect = document.getElementById('btn-connect');
    
    inSelect.innerHTML = '<option value="">Sélectionner...</option>';
    outSelect.innerHTML = '<option value="">Sélectionner...</option>';

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

// --- CONNEXION AUX PORTS CHOISIS ---
document.getElementById('btn-connect').addEventListener('click', () => {
    const inId = document.getElementById('midi-in').value;
    const outId = document.getElementById('midi-out').value;

    midiInPort = midiAccess.inputs.get(inId);
    midiOutPort = midiAccess.outputs.get(outId);

    midiInPort.onmidimessage = handleMidiMessage;

    // Masquer le header de config et afficher l'interface principale
    document.getElementById('setup-header').classList.add('hidden');
    document.getElementById('app-container').classList.remove('hidden');
    
    generateMatrix();
});

// --- RECEPTION DES MESSAGES MIDI ---
function handleMidiMessage(message) {
    const data = message.data;
    
    // Dump des 64 VCA [F0 00 20 09 0A 41 ...]
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

// --- ENVOI DES MESSAGES MIDI ---
function updateVCA(inIdx, outIdx, value) {
    if (!midiOutPort) return;
    
    value = Math.max(0, Math.min(127, value));
    vcaLevels[outIdx][inIdx] = value;
    
    const vcaAddress = inIdx + (8 * outIdx);
    const message = [0xf0, 0x00, 0x20, 0x09, 0x0a, 0x04, vcaAddress, value, 0xf7];
    midiOutPort.send(message);
}

// --- ENVOI DES MESSAGES MIDI GROUPES (Jusqu'à 8) ---
function updateMultipleVCAs(value) {
    if (!midiOutPort || selectedVCAs.length === 0) return;
    
    value = Math.max(0, Math.min(127, value));
    
    // Début de la commande SysEx pour la MAJ 
    const message = [0xf0, 0x00, 0x20, 0x09, 0x0a, 0x04];
    
    selectedVCAs.forEach(vca => {
        // Mise à jour visuelle et locale
        vcaLevels[vca.outIdx][vca.inIdx] = value;
        drawFader(vca.canvasId, value);
        
        // Ajout des paires [Adresse, Valeur] au message MIDI 
        const vcaAddress = vca.inIdx + (8 * vca.outIdx);
        message.push(vcaAddress);
        message.push(value);
    });
    
    // Fin du message SysEx 
    message.push(0xf7);
    midiOutPort.send(message);
}

// --- GENERATION DE L'INTERFACE GRAPHIQUE ---
function generateMatrix() {
    const container = document.getElementById('matrix-container');
    container.innerHTML = ''; 

    for (let inIdx = 0; inIdx < 8; inIdx++) {
        for (let outIdx = 0; outIdx < 8; outIdx++) {
            const faderDiv = document.createElement('div');
            faderDiv.className = 'fader-container';
            
            const label = document.createElement('div');
            label.className = 'fader-label';
            label.innerText = `IN ${inIdx+1}/OUT ${outIdx+1}`;
            
            const canvas = document.createElement('canvas');
            canvas.id = `Conn_${inIdx}_${outIdx}`;
            canvas.width = 91;
            canvas.height = 91;
            
            faderDiv.appendChild(label);
            faderDiv.appendChild(canvas);
            container.appendChild(faderDiv);

            drawFader(canvas.id, 0);
            setupCanvasInteraction(canvas, inIdx, outIdx);
        }
    }
}

// --- DESSIN DU FADER ---
function drawFader(canvasId, value) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const size = 91;
    const padding = 5;
    
    ctx.clearRect(0, 0, size, size);
    
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, size, size);
    
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

// --- INTERACTION AVEC LES FADERS (Mise à jour avec Sélection Multiple) ---
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
        
        // Vérifier si ce fader fait partie d'une sélection
        const isSelected = selectedVCAs.some(v => v.inIdx === inIdx && v.outIdx === outIdx);
        
        if (isSelected && selectedVCAs.length > 0) {
            // Bouger TOUS les faders sélectionnés en même temps
            updateMultipleVCAs(val);
        } else {
            // Bouger uniquement CE fader
            drawFader(canvas.id, val);
            updateVCA(inIdx, outIdx, val); 
        }
    };

    canvas.addEventListener('mousedown', (e) => {
        if (isMultiSelectMode) {
            // --- LOGIQUE DE SELECTION ---
            const idx = selectedVCAs.findIndex(v => v.inIdx === inIdx && v.outIdx === outIdx);
            if (idx > -1) {
                // Déjà sélectionné : on le retire
                selectedVCAs.splice(idx, 1);
                canvas.parentElement.classList.remove('selected');
            } else {
                // Pas sélectionné : on l'ajoute (limite de 8)
                if (selectedVCAs.length < 8) {
                    selectedVCAs.push({ inIdx, outIdx, canvasId: canvas.id });
                    canvas.parentElement.classList.add('selected');
                } else {
                    alert("Vous ne pouvez sélectionner que 8 VCA maximum en même temps.");
                }
            }
            // Afficher/Masquer le bouton "Vider la sélection"
            document.getElementById('btn-clear-selection').classList.toggle('hidden', selectedVCAs.length === 0);
        } else {
            // --- LOGIQUE DE MOUVEMENT NORMALE ---
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

// --- EVENEMENTS SIDEBAR ---

// Bouton Clear All
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

// Bouton Monitoring
document.getElementById('btn-monitor').addEventListener('click', (e) => {
    if (!midiOutPort) return;
    
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        e.target.innerText = "Activer Monitoring (10Hz)";
        e.target.style.backgroundColor = "#ff0000";
    } else {
        monitoringInterval = setInterval(() => {
            midiOutPort.send([0xf0, 0x00, 0x20, 0x09, 0x0a, 0x03, 0xf7]);
        }, 100);
        e.target.innerText = "Désactiver Monitoring";
        e.target.style.backgroundColor = "#00aa00";
    }
});

// --- GESTION DU MODE SELECTION MULTIPLE ---
document.getElementById('btn-multi-select').addEventListener('click', (e) => {
    isMultiSelectMode = !isMultiSelectMode;
    e.target.innerText = isMultiSelectMode ? "Sélection Multiple : ON" : "Sélection Multiple : OFF";
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

// Boutons Presets (1 à 16)
document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', (e) => {
        if (!midiOutPort) return;
        const presetNum = parseInt(e.target.getAttribute('data-preset'), 10);
        
        // SET preset command: F0 00 20 09 02 pt F7
        midiOutPort.send([0xf0, 0x00, 0x20, 0x09, 0x02, presetNum, 0xf7]);
        
        // Demander à rafraichir l'affichage après le changement
        setTimeout(() => {
            midiOutPort.send([0xf0, 0x00, 0x20, 0x09, 0x0a, 0x03, 0xf7]); 
        }, 50);
    });
});

// --- DEMARRAGE ---
startMidi();
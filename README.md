# VCATRIX Editor - Web MIDI Controller

VCATRIX Editor is a modern, intuitive web interface designed for remote control of the Alyseum VCATRIX analog matrix module. It lets you manage the machine's 64 VCAs through the MIDI SysEx protocol directly from a web browser.

## Features

- Interactive 8x8 matrix: Visual control of the 64 connection points using 45-degree diagonal faders.
- Real-time monitoring at 10 Hz: Continuous synchronization between the web interface and the hardware state.
- Preset management: Instant selection and loading of the 16 internal hardware presets.
- Group mode with multi-select: Select up to 8 VCAs and modify them simultaneously with a single optimized MIDI command.
- Bulk dump for backup and restore:
  - Export all 16 presets into a single `.vca` file saved directly to your computer.
  - Import through a modal that lets you load the entire file or target a specific preset to overwrite.
- Local edit indicator for dirty state: Fader cursors turn red when modified locally in the editor, and revert to green when a hardware preset is loaded or the matrix is cleared.
- Demo mode: Explore and test the user interface safely without any MIDI hardware connected.

## Installation And Usage

### Prerequisites

- A web browser that supports the Web MIDI API. Google Chrome or Brave are recommended.
- Apple Safari does not currently support Web MIDI natively.
- A MIDI interface connected to your computer, or virtual MIDI ports such as the macOS IAC Driver for software testing.

### Launching The Editor

1. Download the three core files: `index.html`, `style.css`, and `script.js`.
2. Place them together in the same folder.
3. Open `index.html` in your supported web browser.
4. Select your MIDI In and MIDI Out ports from the dropdown menus and click Connect, or click Demo to explore offline.

## MIDI Technical Details

The editor communicates using System Exclusive (SysEx) messages, utilizing the Alyseum Manufacturer ID `00 20 09` and the VCATRIX Device ID `0A`.

### Implemented Commands

- `01`: Clear all VCAs.
- `02`: Set preset.
- `03`: Display request for monitoring.
- `04`: Update VCA value for a single VCA or a group.
- `05`: Dump request to receive data to the computer.
- `06`: Dump transmit to load data to the hardware.

## Credits

Developed by Buys Aurélien.

## License And Disclaimer

This software is provided "as is". In accordance with the Alyseum manual, the user is responsible for any modifications made. Neither Alyseum nor the developer can be held liable for any improper use of the hardware via this editor.

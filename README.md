# Antigravity Hub

A premium, web-based remote control client for macOS and the active Antigravity 2.0 agent session, optimized specifically for iPhone and mobile screens.

## Features

- **Media Control**: AppleScript controls for volume adjustment, muting, play/pause, and next/prev track switching (works with Spotify and Apple Music).
- **System Metrics**: Real-time physical memory (PhysMem), CPU usage, and battery status relay.
- **Interactive Terminal**: An integrated, interactive web-based zsh terminal running directly on your Mac.
- **Direct Agent Chat**: Real-time bi-directional conversation interface with model switching, quick workflow action pills, and status logging linked to the local `agentapi` CLI tool.
- **Project/Conversation Switcher**: View, search, and activate previous workspace projects and conversation logs directly from the control panel.

## Technology Stack

- **Backend**: Node.js, Express, WebSocket (`ws`)
- **Frontend**: Single-Page HTML, Vanilla CSS (Glassmorphism design system), Vanilla JavaScript
- **Integration**: macOS AppleScript execution (`osascript`), raw process monitors (`top`, `pmset`), child process execution (`spawn`), and Antigravity active logs watcher (`fs.watch`).

## Setup & Running

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start the server**:
   ```bash
   npm start
   ```

3. **Access from iPhone**:
   - Ensure your iPhone is connected to the **same Wi-Fi network** as your Mac.
   - Open Safari or Chrome on your iPhone.
   - Navigate to the IP address printed in the server logs (e.g., `http://192.168.1.X:3000`).

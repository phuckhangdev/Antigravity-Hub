import Cocoa
import Foundation
import SystemConfiguration

struct HealthResponse: Codable {
    let status: String
    let model: String
    let agentStatus: String
    let agentStep: String
    let pinSecurityEnabled: Bool
    let pin: String
    let tunnelUrl: String?
}

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    
    var nodeProcess: Process?
    var isRunning = false
    var checkTimer: Timer?
    
    // Menu items to update
    var statusMenuItem: NSMenuItem!
    var modelMenuItem: NSMenuItem!
    var agentMenuItem: NSMenuItem!
    var pinMenuItem: NSMenuItem!
    var tunnelMenuItem: NSMenuItem!
    var copyTunnelMenuItem: NSMenuItem!
    var startMenuItem: NSMenuItem!
    var stopMenuItem: NSMenuItem!
    
    var currentTunnelUrl: String?
    
    func applicationDidFinishLaunching(_ aNotification: Notification) {
        // Run as accessory app (no dock icon)
        NSApp.setActivationPolicy(.accessory)
        
        setupStatusBar()
        startStatusChecking()
        
        // Try to start server initially if not already running
        checkHealth { isAlive, _ in
            if !isAlive {
                self.startServer()
            }
        }
    }
    
    func applicationWillTerminate(_ notification: Notification) {
        stopServer()
    }
    
    func setupStatusBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        
        if let button = statusItem.button {
            button.title = "🔴 Antigravity"
        }
        
        menu = NSMenu()
        
        statusMenuItem = NSMenuItem(title: "Status: Stopped 🔴", action: nil, keyEquivalent: "")
        menu.addItem(statusMenuItem)
        
        modelMenuItem = NSMenuItem(title: "Model: None", action: nil, keyEquivalent: "")
        menu.addItem(modelMenuItem)
        
        agentMenuItem = NSMenuItem(title: "Agent: Idle", action: nil, keyEquivalent: "")
        menu.addItem(agentMenuItem)
        
        pinMenuItem = NSMenuItem(title: "PIN: Loading...", action: nil, keyEquivalent: "")
        menu.addItem(pinMenuItem)
        
        tunnelMenuItem = NSMenuItem(title: "Tunnel: Checking...", action: nil, keyEquivalent: "")
        menu.addItem(tunnelMenuItem)
        
        copyTunnelMenuItem = NSMenuItem(title: "Copy Tunnel URL", action: #selector(copyTunnelClicked), keyEquivalent: "c")
        copyTunnelMenuItem.target = self
        copyTunnelMenuItem.isEnabled = false
        menu.addItem(copyTunnelMenuItem)
        
        menu.addItem(NSMenuItem.separator())
        
        startMenuItem = NSMenuItem(title: "Start Server", action: #selector(startServerClicked), keyEquivalent: "s")
        startMenuItem.target = self
        menu.addItem(startMenuItem)
        
        stopMenuItem = NSMenuItem(title: "Stop Server", action: #selector(stopServerClicked), keyEquivalent: "x")
        stopMenuItem.target = self
        menu.addItem(stopMenuItem)
        
        let openWebItem = NSMenuItem(title: "Open Web Interface", action: #selector(openWebInterface), keyEquivalent: "o")
        openWebItem.target = self
        menu.addItem(openWebItem)
        
        menu.addItem(NSMenuItem.separator())
        
        let quitItem = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
        
        statusItem.menu = menu
        
        updateMenuStates(active: false)
    }
    
    func updateMenuStates(active: Bool) {
        self.isRunning = active
        if active {
            statusItem.button?.title = "🟢 Antigravity"
            statusMenuItem.title = "Status: Running 🟢"
            startMenuItem.isEnabled = false
            stopMenuItem.isEnabled = true
        } else {
            statusItem.button?.title = "🔴 Antigravity"
            statusMenuItem.title = "Status: Stopped 🔴"
            modelMenuItem.title = "Model: None"
            agentMenuItem.title = "Agent: Offline"
            pinMenuItem.title = "PIN: N/A"
            tunnelMenuItem.title = "Tunnel: N/A"
            copyTunnelMenuItem.isEnabled = false
            currentTunnelUrl = nil
            startMenuItem.isEnabled = true
            stopMenuItem.isEnabled = false
        }
    }
    
    @objc func copyTunnelClicked() {
        if let url = currentTunnelUrl {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(url, forType: .string)
            print("Copied tunnel URL to clipboard: \(url)")
        }
    }
    
    func startStatusChecking() {
        checkTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.checkHealth { isAlive, response in
                DispatchQueue.main.async {
                    if isAlive, let resp = response {
                        self?.updateMenuStates(active: true)
                        self?.modelMenuItem.title = "Model: \(resp.model)"
                        self?.agentMenuItem.title = "Agent: \(resp.agentStatus.uppercased()) (\(resp.agentStep))"
                        self?.pinMenuItem.title = "PIN: \(resp.pin)"
                        if let tunnel = resp.tunnelUrl, !tunnel.isEmpty {
                            self?.tunnelMenuItem.title = "Tunnel: \(tunnel)"
                            self?.copyTunnelMenuItem.isEnabled = true
                            self?.currentTunnelUrl = tunnel
                        } else {
                            self?.tunnelMenuItem.title = "Tunnel: Disabled"
                            self?.copyTunnelMenuItem.isEnabled = false
                            self?.currentTunnelUrl = nil
                        }
                    } else {
                        self?.updateMenuStates(active: false)
                    }
                }
            }
        }
    }
    
    func checkHealth(completion: @escaping (Bool, HealthResponse?) -> Void) {
        guard let url = URL(string: "https://127.0.0.1:3001/api/health") else {
            completion(false, nil)
            return
        }
        
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 1.0
        let delegate = LocalhostSSLDelegate()
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        
        let task = session.dataTask(with: url) { data, response, error in
            if error != nil {
                completion(false, nil)
                return
            }
            
            guard let data = data else {
                completion(false, nil)
                return
            }
            
            do {
                let decoder = JSONDecoder()
                let resp = try decoder.decode(HealthResponse.self, from: data)
                completion(true, resp)
            } catch {
                completion(true, nil) // running but json decode failed or parsing error
            }
        }
        task.resume()
    }
    
    @objc func startServerClicked() {
        startServer()
    }
    
    @objc func stopServerClicked() {
        stopServer()
    }
    
    func startServer() {
        if nodeProcess != nil { return }
        
        let exePath = CommandLine.arguments[0]
        let absoluteExeURL = URL(fileURLWithPath: exePath, relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath)).standardized
        let processDirectory = absoluteExeURL.deletingLastPathComponent().path
        
        // First, ensure the ports are clean
        killProcessOnPorts()
        
        let task = Process()
        task.launchPath = "/bin/zsh"
        task.arguments = ["-l", "-c", "npm start"]
        task.currentDirectoryPath = processDirectory
        
        nodeProcess = task
        
        do {
            try task.run()
            print("Node server process launched in: \(processDirectory)")
        } catch {
            print("Failed to run Node server: \(error)")
            nodeProcess = nil
        }
    }
    
    func stopServer() {
        if let process = nodeProcess {
            process.terminate()
            nodeProcess = nil
        }
        killProcessOnPorts()
        updateMenuStates(active: false)
    }
    
    func killProcessOnPorts() {
        let task = Process()
        task.launchPath = "/bin/zsh"
        task.arguments = ["-l", "-c", "lsof -t -i :3000,3001 | xargs kill -9 2>/dev/null || true"]
        
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            print("Error killing port 3000/3001 processes: \(error)")
        }
    }
    
    @objc func openWebInterface() {
        if let url = URL(string: "http://localhost:3000") {
            NSWorkspace.shared.open(url)
        }
    }
    
    @objc func quitApp() {
        stopServer()
        NSApplication.shared.terminate(self)
    }
}

class LocalhostSSLDelegate: NSObject, URLSessionDelegate {
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust {
            if let serverTrust = challenge.protectionSpace.serverTrust {
                completionHandler(.useCredential, URLCredential(trust: serverTrust))
                return
            }
        }
        completionHandler(.performDefaultHandling, nil)
    }
}

// Start NSApplication
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()

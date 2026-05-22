#!/usr/bin/env python3
import os
import json
import argparse
from datetime import datetime

STATUS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'agent_status.json')

def load_status():
    if not os.path.exists(STATUS_FILE):
        return {
            "status": "idle",
            "current_step": "Ready for commands",
            "logs": []
        }
    try:
        with open(STATUS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {
            "status": "idle",
            "current_step": "Ready for commands",
            "logs": []
        }

def save_status(data):
    with open(STATUS_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def main():
    parser = argparse.ArgumentParser(description="Update Antigravity Agent Status for Remote Control")
    parser.add_argument('--status', choices=['idle', 'busy', 'completed', 'error'], help="Set current agent status")
    parser.add_argument('--step', type=str, help="Set current execution step description")
    parser.add_argument('--log', type=str, action='append', help="Append one or more log messages")
    parser.add_argument('--clear', action='store_true', help="Clear all existing logs")
    
    args = parser.parse_args()
    
    status_data = load_status()
    
    if args.clear:
        status_data['logs'] = []
        
    if args.status:
        status_data['status'] = args.status
        
    if args.step:
        status_data['current_step'] = args.step
        
    if args.log:
        for log_msg in args.log:
            status_data['logs'].append(log_msg)
            
    save_status(status_data)
    print(f"Agent status updated. Status: {status_data['status']} | Step: {status_data['current_step']}")

if __name__ == '__main__':
    main()

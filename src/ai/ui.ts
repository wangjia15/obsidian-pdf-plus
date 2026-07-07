// Central registration of all AI UI surfaces (view, commands, menus) onto one Component
// that lives only while AI is active. Feature modules self-register via addAIRegistration();
// AIManager.registerAIUI() invokes them when AI activates. This avoids AIManager importing
// feature modules (no cycles) and lets each story add its registrations independently.

import { Component } from 'obsidian';
import type { AIManager } from './index';

type Registration = (manager: AIManager, active: Component) => void;

const registrations: Registration[] = [];

/** Feature modules call this at load time to contribute UI surfaces. */
export function addAIRegistration(fn: Registration) {
    registrations.push(fn);
}

/** Called by AIManager.activate(); runs every registered feature's UI setup. */
export function registerAIUI(manager: AIManager, active: Component) {
    for (const fn of registrations) {
        try {
            fn(manager, active);
        } catch (err) {
            console.error('PDF++ AI: registration failed', err);
        }
    }
}

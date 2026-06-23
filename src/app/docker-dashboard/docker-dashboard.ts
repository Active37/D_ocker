import { Component, signal, computed, effect, inject, OnDestroy, AfterViewInit, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';
import { DockerCacheService } from './docker-cache';
import * as d3 from 'd3';

// Simulated Models for Container Engine
export interface VirtualFile {
  type: 'file' | 'dir';
  content?: string;
  size?: number;
}

export type FileSystem = Record<string, VirtualFile>;

export interface DockerImage {
  id: string;
  tag: string;
  size: string;
  created: string;
  isPrebuilt: boolean;
  layers: string[];
  dockerfile: string;
  env: Record<string, string>;
  workdir: string;
  ports: number[];
  cmd: string;
  filesystem: FileSystem;
}

export interface VolumeMount {
  volumeName: string;
  containerPath: string;
}

export interface ContainerStats {
  cpu: number;
  memory: number;
  memoryLimit: number;
  netIn: number;
  netOut: number;
}

export interface LogLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  time: string;
}

export interface DockerContainer {
  id: string;
  name: string;
  imageId: string;
  imageTag: string;
  status: 'running' | 'stopped' | 'paused' | 'exited';
  exitCode: number;
  created: string;
  ports: Record<number, number>; // e.g., { 8080: 80 }
  ipAddress: string;
  network: string; // e.g., 'bridge'
  env: Record<string, string>;
  workdir: string;
  volumes: VolumeMount[];
  stats: ContainerStats;
  logs: LogLine[];
  filesystem: FileSystem;
  currentWorkdir: string;
  history: string[]; // shell command history
  cmd: string;
  installedPackages?: string[];
}

export interface DockerVolume {
  name: string;
  driver: 'local';
  scope: 'local';
  created: string;
  files: Record<string, string>; // Map of relative files inside volume root
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: 'bridge' | 'host' | 'none';
  subnet: string;
  gateway: string;
  containers: string[]; // List of connected container IDs
}

@Component({
  selector: 'app-docker-dashboard',
  imports: [CommonModule, ReactiveFormsModule, MatIconModule],
  templateUrl: './docker-dashboard.html',
  styleUrl: './docker-dashboard.css',
})
export class DockerDashboard implements OnDestroy, AfterViewInit {
  private fb = inject(FormBuilder);
  public cacheService = inject(DockerCacheService);

  // Active Panel Navigation State
  activeTab = signal<'dashboard' | 'containers' | 'images' | 'volumes' | 'networks' | 'copilot' | 'workspace'>('workspace');

  // --- D3 Dashboard Metrics State ---
  selectedMetricType = signal<'both' | 'cpu' | 'memory'>('both');
  runningContainersCount = computed(() => this.runningContainers().length);
  totalCpuUsage = computed(() => this.runningContainers().reduce((acc, c) => acc + (c.stats?.cpu || 0), 0));
  totalMemUsage = computed(() => this.runningContainers().reduce((acc, c) => acc + (c.stats?.memory || 0), 0));
  
  stoppedContainersCount = computed(() => this.containers().length - this.runningContainersCount());
  activeContainersRatio = computed(() => this.containers().length > 0 ? (this.runningContainersCount() / this.containers().length) * 100 : 0);
  cpuUtilizationPercent = computed(() => Math.min(100, this.totalCpuUsage()));
  memUtilizationPercent = computed(() => Math.min(100, (this.totalMemUsage() / 1536) * 100));
  
  hostStatsHistory: { timestamp: Date; cpu: number; memory: number }[] = [];
  private resizeObserver: ResizeObserver | null = null;

  // Template utilities
  Object = Object;
  Math = Math;

  getContainersInNetwork(networkName: string): DockerContainer[] {
    return this.containers().filter(c => c.network === networkName);
  }

  cosTable(deg: number): number {
    return Math.cos((deg * Math.PI) / 180);
  }

  sinTable(deg: number): number {
    return Math.sin((deg * Math.PI) / 180);
  }

  // Interactive Overlays
  logsContainer = signal<DockerContainer | null>(null);
  terminalContainer = signal<DockerContainer | null>(null);
  webBrowserContainer = signal<DockerContainer | null>(null);
  webBrowserHostPort = signal<number | null>(null);
  webBrowserContent = signal<string>('');

  // Enhanced Terminal States (Xterm-style)
  terminalTheme = signal<'classic' | 'green' | 'amber' | 'cyan' | 'solarized'>('cyan');
  termHistoryIndex = 0;
  termActiveApp = signal<'htop' | null>(null);
  runningContainers = computed(() => this.containers().filter(c => c.status === 'running'));

  // AI Copilot state
  copilotInput = new FormControl('');
  copilotMessages = signal<{ role: 'user' | 'assistant'; text: string; time: string }[]>([
    {
      role: 'assistant',
      text: "👋 Hello! I am your AI Docker Copilot. Ask me how to build, optimize, or troubleshoot Docker environments. You can also generate a custom Dockerfile and load it directly into the builder!",
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  copilotLoading = signal<boolean>(false);

  // Image & Registry State
  dockerfileInput = signal<string>(`FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "app.js"]`);

  newImageTag = new FormControl('my-node-service:latest');
  buildLogs = signal<string[]>([]);
  isBuilding = signal<boolean>(false);
  buildProgress = signal<number>(0);
  selectedTemplate = signal<string>('node');

  // --- Enhanced Real-Time Log Viewer States ---
  buildTimeElapsed = signal<number>(0);
  buildLogSearchQuery = signal<string>('');
  buildLogFilterSeverity = signal<string>('all'); // 'all', 'info', 'warn', 'success', 'cache'
  autoScrollLogs = signal<boolean>(true);
  logCopied = signal<boolean>(false);
  
  // Track detailed state of each build step
  buildTimelineSteps = signal<{
    index: number;
    instruction: string;
    arguments: string;
    status: 'pending' | 'running' | 'completed' | 'cached';
    durationMs?: number;
    hash?: string;
  }[]>([]);

  // Active step pointer
  activeBuildStepIndex = signal<number>(-1);

  filteredBuildLogs = computed(() => {
    const query = this.buildLogSearchQuery().toLowerCase().trim();
    const filter = this.buildLogFilterSeverity();
    const logs = this.buildLogs();
    
    return logs.filter(line => {
      // search query match
      if (query && !line.toLowerCase().includes(query)) {
        return false;
      }
      
      // severity match
      if (filter === 'all') return true;
      if (filter === 'info') return !line.includes('warning') && !line.includes('Error') && !line.startsWith('Step') && !line.includes('🟢');
      if (filter === 'warn') {
        const lower = line.toLowerCase();
        return lower.includes('warning') || lower.includes('error') || lower.includes('failed') || line.includes('🔴') || line.includes('⚠️');
      }
      if (filter === 'cache') return line.toLowerCase().includes('cache');
      if (filter === 'success') return line.includes('🟢') || line.includes('Successfully') || line.toLowerCase().includes('complete');
      return true;
    });
  });

  clearBuildLogs(): void {
    this.buildLogs.set([]);
  }

  copyBuildLogs(): void {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(this.buildLogs().join('\n')).then(() => {
        this.logCopied.set(true);
        setTimeout(() => this.logCopied.set(false), 2000);
      });
    }
  }

  downloadBuildLogs(): void {
    if (typeof window !== 'undefined' && typeof document !== 'undefined') {
      const blob = new Blob([this.buildLogs().join('\n')], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `docker_build_${this.newImageTag.value || 'image'}.log`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  // --- Real-time Dockerfile Analysis & Linter ---
  editorSubTab = signal<'edit' | 'preview'>('edit');
  rightPaneSubTab = signal<'layers' | 'logs'>('layers');
  editingLayerIdx = signal<number | null>(null);
  editingLayerValue = new FormControl('');

  parsedDockerfile = computed(() => {
    const raw = this.dockerfileInput();
    const lines = raw.split('\n');
    return lines.map((lineStr, idx) => {
      const trimmed = lineStr.trim();
      const isEmpty = trimmed === '';
      const isComment = trimmed.startsWith('#');
      
      let instruction = '';
      let args = '';
      
      if (!isEmpty && !isComment) {
        const spaceIndex = trimmed.indexOf(' ');
        if (spaceIndex > 0) {
          instruction = trimmed.substring(0, spaceIndex).trim();
          args = trimmed.substring(spaceIndex + 1).trim();
        } else {
          instruction = trimmed;
        }
      }
      
      return {
        lineNumber: idx + 1,
        raw: lineStr,
        instruction,
        arguments: args,
        isComment,
        isEmpty
      };
    });
  });

  dockerfileErrors = computed(() => {
    const lines = this.parsedDockerfile();
    const errors: {
      line: number;
      instruction: string;
      severity: 'error' | 'warning';
      message: string;
      type: string;
      tip: string;
    }[] = [];
    
    // Check 1: FROM presence
    const hasFrom = lines.some(l => l.instruction.toUpperCase() === 'FROM');
    if (!hasFrom && lines.some(l => !l.isEmpty && !l.isComment)) {
      errors.push({
        line: 1,
        instruction: 'FROM',
        severity: 'error',
        message: 'No base image specified.',
        type: 'missing_from',
        tip: 'Begin your Dockerfile with a FROM command (e.g., "FROM node:18-alpine") to specify the parent image.'
      });
    }

    let cmdCount = 0;
    
    lines.forEach((l, idx) => {
      if (l.isEmpty || l.isComment) return;
      
      const upperInst = l.instruction.toUpperCase();
      const validInstructions = [
        'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 
        'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 
        'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL'
      ];
      
      // Check 2: Unrecognized instruction
      if (!validInstructions.includes(upperInst)) {
        errors.push({
          line: l.lineNumber,
          instruction: l.instruction,
          severity: 'error',
          message: `Unrecognized instruction '${l.instruction}'.`,
          type: 'unrecognized_instruction',
          tip: `Ensure the instruction is spelled correctly. Common instructions: FROM, RUN, COPY, ENV, EXPOSE, CMD, WORKDIR.`
        });
        return;
      }
      
      // Check 3: Check uppercase suggestion
      if (l.instruction !== upperInst) {
        errors.push({
          line: l.lineNumber,
          instruction: l.instruction,
          severity: 'warning',
          message: `Instruction '${l.instruction}' should be uppercase '${upperInst}'.`,
          type: 'lowercase_instruction',
          tip: `It is standard convention to use UPPERCASE for Dockerfile action words to distinguish them from arguments.`
        });
      }
      
      // Check 4: Missing arguments
      if (!l.arguments && upperInst !== 'CMD' && upperInst !== 'ENTRYPOINT' && upperInst !== 'FROM' && upperInst !== 'RUN') {
        errors.push({
          line: l.lineNumber,
          instruction: upperInst,
          severity: 'error',
          message: `Empty arguments for '${upperInst}' instruction.`,
          type: 'empty_arguments',
          tip: `Provide arguments for your instruction. For example: "EXPOSE 3000" or "WORKDIR /app".`
        });
      }
      
      // Check 5: Multiple CMD warnings
      if (upperInst === 'CMD') {
        cmdCount++;
        if (cmdCount > 1) {
          errors.push({
            line: l.lineNumber,
            instruction: upperInst,
            severity: 'warning',
            message: `Multiple CMD instructions found. Only the final one is active.`,
            type: 'multiple_cmd',
            tip: `Docker only executes the final CMD instruction. Previous CMDs on lines before this will be ignored.`
          });
        }
        
        // Check 6: Single quotes inside JSON array for CMD
        const argsStr = l.arguments.trim();
        if (argsStr.startsWith('[') && argsStr.endsWith(']')) {
          if (argsStr.includes("'")) {
            errors.push({
              line: l.lineNumber,
              instruction: upperInst,
              severity: 'error',
              message: `Single quotes used in CMD JSON array structure.`,
              type: 'cmd_single_quotes',
              tip: `Change single quotes to double quotes. Example: CMD ["node", "app.js"]. Docker requires double quotes for exec form.`
            });
          }
        }
      }
      
      // Check 7: EXPOSE ports validation
      if (upperInst === 'EXPOSE') {
        const portStr = l.arguments.trim().split(/\s+/)[0];
        const portNum = parseInt(portStr, 10);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
          errors.push({
            line: l.lineNumber,
            instruction: upperInst,
            severity: 'error',
            message: `Invalid port mapping number '${portStr}'.`,
            type: 'invalid_port',
            tip: `Port must be a valid integer between 1 and 65535. E.g., EXPOSE 80 or EXPOSE 3000.`
          });
        }
      }
      
      // Check 8: COPY destination argument presence
      if (upperInst === 'COPY' || upperInst === 'ADD') {
        const parts = l.arguments.trim().split(/\s+/);
        if (parts.length < 2 && !l.arguments.includes('[')) {
          errors.push({
            line: l.lineNumber,
            instruction: upperInst,
            severity: 'error',
            message: `COPY/ADD requires both source and destination folders.`,
            type: 'copy_missing_dest',
            tip: `Specify source and destination. E.g., "COPY package.json ./" or "COPY . ."`
          });
        }
      }
      
      // Check 9: WORKDIR before relative COPY warning
      if (upperInst === 'COPY' && !lines.some((prevLine, prevIdx) => prevIdx < idx && prevLine.instruction.toUpperCase() === 'WORKDIR')) {
        const parts = l.arguments.trim().split(/\s+/);
        const dest = parts[parts.length - 1] || '';
        if (dest.startsWith('.') || dest === './' || dest === '.') {
          errors.push({
            line: l.lineNumber,
            instruction: upperInst,
            severity: 'warning',
            message: `Relative COPY path used without a prior WORKDIR defined.`,
            type: 'copy_relative_no_workdir',
            tip: `It is highly recommended to declare "WORKDIR /app" first so files don't clutter the default filesystem root directory.`
          });
        }
      }

      // Check 10: Best practice - Combine consecutive RUN instructions
      const nextInstLine = lines.slice(idx + 1).find(nl => !nl.isEmpty && !nl.isComment);
      if (upperInst === 'RUN' && nextInstLine && nextInstLine.instruction.toUpperCase() === 'RUN') {
        errors.push({
          line: l.lineNumber,
          instruction: upperInst,
          severity: 'warning',
          message: `Multiple consecutive RUN commands can be combined.`,
          type: 'consecutive_run',
          tip: `Combine consecutive RUN instructions using '&& \\' to reduce image layer count and keep the final image size smaller.`
        });
      }

      // Check 11: Best practice - apt-get update split
      if (upperInst === 'RUN' && l.arguments.includes('apt-get update') && !l.arguments.includes('apt-get install')) {
        errors.push({
          line: l.lineNumber,
          instruction: upperInst,
          severity: 'warning',
          message: `'apt-get update' should be combined with 'apt-get install' in the same RUN instruction.`,
          type: 'apt_get_update_separated',
          tip: `Combine 'apt-get update' and 'apt-get install' in a single RUN instruction (e.g., RUN apt-get update && apt-get install -y ...) to ensure package dependencies are downloaded from a fresh index.`
        });
      }

      // Check 12: Best practice - missing -y flag in apt-get install
      if (upperInst === 'RUN' && (l.arguments.includes('apt-get install') || l.arguments.includes('apt install')) && !l.arguments.includes('-y')) {
        errors.push({
          line: l.lineNumber,
          instruction: upperInst,
          severity: 'error',
          message: `apt-get install missing '-y' (non-interactive) flag.`,
          type: 'apt_get_missing_y',
          tip: `Without the '-y' flag, the docker build will hang/fail, expecting interactive shell input. Add '-y'.`
        });
      }

      // Check 13: Best practice - clear npm cache
      if (upperInst === 'RUN' && l.arguments.includes('npm install') && !l.arguments.includes('npm cache clean')) {
        errors.push({
          line: l.lineNumber,
          instruction: upperInst,
          severity: 'warning',
          message: `npm install does not clear the npm cache.`,
          type: 'npm_install_no_cache_clean',
          tip: `Add '&& npm cache clean --force' at the end of the command to remove redundant cached packages and keep the layer tiny.`
        });
      }

      // Check 14: Preferred exec/JSON array form for CMD and ENTRYPOINT
      if ((upperInst === 'CMD' || upperInst === 'ENTRYPOINT') && l.arguments) {
        const trimmedArgs = l.arguments.trim();
        if (trimmedArgs && (!trimmedArgs.startsWith('[') || !trimmedArgs.endsWith(']'))) {
          errors.push({
            line: l.lineNumber,
            instruction: upperInst,
            severity: 'warning',
            message: `Shell form used instead of JSON/exec form for '${upperInst}'.`,
            type: 'shell_form_cmd_entrypoint',
            tip: `Use exec/JSON array form (e.g., ${upperInst} ["node", "server.js"]) instead of shell form to allow proper termination signal handling (SIGTERM).`
          });
        }
      }
    });
    
    return errors;
  });

  applyQuickFix(error: { line: number; instruction: string; severity: 'error' | 'warning'; message: string; type: string; tip: string }) {
    const raw = this.dockerfileInput();
    const lines = raw.split('\n');
    const idx = error.line - 1;
    if (idx < 0 || idx >= lines.length) return;
    
    const line = lines[idx];
    const trimmed = line.trim();
    
    if (error.type === 'lowercase_instruction') {
      const spaceIndex = trimmed.indexOf(' ');
      if (spaceIndex > 0) {
        const inst = trimmed.substring(0, spaceIndex);
        lines[idx] = line.replace(inst, inst.toUpperCase());
      } else {
        lines[idx] = line.replace(trimmed, trimmed.toUpperCase());
      }
    } else if (error.type === 'cmd_single_quotes') {
      lines[idx] = line.replace(/'/g, '"');
    } else if (error.type === 'missing_from') {
      lines.unshift('FROM node:18-alpine');
    } else if (error.type === 'unrecognized_instruction') {
      if (trimmed.toUpperCase().startsWith('INSTALL ')) {
        lines[idx] = line.replace(/install /i, 'RUN ');
      } else {
        lines[idx] = `# Fixed unrecognized instruction: ${line}`;
      }
    } else if (error.type === 'copy_missing_dest') {
      lines[idx] = `${trimmed} ./`;
    } else if (error.type === 'consecutive_run') {
      let nextLineIndex = -1;
      for (let i = idx + 1; i < lines.length; i++) {
        const lStr = lines[i].trim();
        if (lStr && !lStr.startsWith('#')) {
          nextLineIndex = i;
          break;
        }
      }
      if (nextLineIndex !== -1) {
        const nextLineTrim = lines[nextLineIndex].trim();
        const runMatch = nextLineTrim.match(/^run\s+/i);
        if (runMatch) {
          const contentAfterRun = nextLineTrim.substring(runMatch[0].length);
          lines[idx] = `${lines[idx]} && \\\n    ${contentAfterRun}`;
          lines.splice(nextLineIndex, 1);
        }
      }
    } else if (error.type === 'apt_get_missing_y') {
      if (line.includes('apt-get install')) {
        lines[idx] = line.replace('apt-get install', 'apt-get install -y');
      } else if (line.includes('apt install')) {
        lines[idx] = line.replace('apt install', 'apt install -y');
      }
    } else if (error.type === 'npm_install_no_cache_clean') {
      lines[idx] = `${line} && npm cache clean --force`;
    } else if (error.type === 'shell_form_cmd_entrypoint') {
      const instWord = error.instruction;
      const spaceIndex = line.toLowerCase().indexOf(instWord.toLowerCase());
      if (spaceIndex !== -1) {
        const prefix = line.substring(0, spaceIndex + instWord.length);
        const argsPart = line.substring(spaceIndex + instWord.length).trim();
        const tokens = argsPart.split(/\s+/).filter(t => t.length > 0);
        const jsonArgs = JSON.stringify(tokens);
        lines[idx] = `${prefix} ${jsonArgs}`;
      }
    }
    
    this.dockerfileInput.set(lines.join('\n'));
    this.editingLayerIdx.set(null);
  }

  moveLayer(idx: number, direction: 'up' | 'down') {
    const lines = this.dockerfileInput().split('\n');
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= lines.length) return;
    
    const temp = lines[idx];
    lines[idx] = lines[targetIdx];
    lines[targetIdx] = temp;
    
    this.dockerfileInput.set(lines.join('\n'));
    this.editingLayerIdx.set(null);
  }

  deleteLayer(idx: number) {
    const lines = this.dockerfileInput().split('\n');
    lines.splice(idx, 1);
    this.dockerfileInput.set(lines.join('\n'));
    this.editingLayerIdx.set(null);
  }

  addNewLayer(instruction: string) {
    const current = this.dockerfileInput().trim();
    let template = '';
    
    switch (instruction.toUpperCase()) {
      case 'FROM':
        template = 'FROM node:18-alpine';
        break;
      case 'RUN':
        template = 'RUN apk update && apk add curl';
        break;
      case 'COPY':
        template = 'COPY . .';
        break;
      case 'ENV':
        template = 'ENV NEW_API_KEY=secrets_value';
        break;
      case 'EXPOSE':
        template = 'EXPOSE 8080';
        break;
      case 'WORKDIR':
        template = 'WORKDIR /app';
        break;
      case 'CMD':
        template = 'CMD ["node", "app.js"]';
        break;
      default:
        template = 'RUN echo "custom-layer"';
    }
    
    const newVal = current + (current ? '\n' : '') + template;
    this.dockerfileInput.set(newVal);
  }

  startEditLayer(idx: number, currentArgs: string) {
    this.editingLayerIdx.set(idx);
    this.editingLayerValue.setValue(currentArgs);
  }

  saveLayerEdit(idx: number, instruction: string) {
    const lines = this.dockerfileInput().split('\n');
    const newArgs = this.editingLayerValue.value || '';
    if (instruction) {
      lines[idx] = `${instruction} ${newArgs}`;
    } else {
      lines[idx] = newArgs;
    }
    this.dockerfileInput.set(lines.join('\n'));
    this.editingLayerIdx.set(null);
  }

  highlightDockerfile(rawText: string): string {
    if (!rawText) return '<span class="text-slate-500 italic">No instructions</span>';
    const lines = rawText.split('\n');
    return lines.map((line, idx) => {
      const lineNum = idx + 1;
      const trimmed = line.trim();
      const linePrfx = `<span class="inline-block w-6 text-slate-600 font-mono text-right select-none pr-3.5 mr-3 border-r border-slate-800 text-[10px]">${lineNum}</span>`;
      
      if (!trimmed) {
        return `${linePrfx}&nbsp;`;
      }
      
      if (trimmed.startsWith('#')) {
        return `${linePrfx}<span class="text-slate-550 italic">${this.escapeHtml(line)}</span>`;
      }
      
      const spaceIndex = trimmed.indexOf(' ');
      if (spaceIndex > 0) {
        const cmd = trimmed.substring(0, spaceIndex);
        const args = trimmed.substring(spaceIndex + 1);
        const upperCmd = cmd.toUpperCase();
        
        const validInstructions = [
          'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 
          'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 
          'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL'
        ];
        
        const isInstructionValid = validInstructions.includes(upperCmd);
        const isUppercase = cmd === upperCmd;
        
        let cmdClass = '';
        if (isInstructionValid) {
          cmdClass = isUppercase ? 'text-amber-400 font-bold' : 'text-amber-450/80 font-bold italic';
        } else {
          cmdClass = 'text-rose-400 font-bold underline decoration-dotted';
        }
        
        let escapedArgs = this.escapeHtml(args);
        
        if (escapedArgs.startsWith('[') && escapedArgs.endsWith(']')) {
          escapedArgs = escapedArgs.replace(/"([^"]+)"/g, '<span class="text-emerald-400">"$1"</span>');
          escapedArgs = escapedArgs.replace(/'([^']+)'/g, '<span class="text-rose-500 font-bold">\'$1\'</span>');
        } else {
          escapedArgs = escapedArgs.replace(/(\b\d{2,5}\b)/g, '<span class="text-emerald-400 font-semibold font-mono">$1</span>');
          escapedArgs = escapedArgs.replace(/(\b[A-Za-z0-9_]+)=/g, '<span class="text-blue-400 font-semibold">$1</span>=');
        }
        
        return `${linePrfx}<span class="${cmdClass}">${cmd}</span> ${escapedArgs}`;
      } else {
        const upperCmd = trimmed.toUpperCase();
        const validInstructions = [
          'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 
          'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 
          'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL'
        ];
        const cmdClass = validInstructions.includes(upperCmd) ? 'text-amber-400 font-bold' : 'text-rose-400 font-bold underline decoration-dotted';
        return `${linePrfx}<span class="${cmdClass}">${this.escapeHtml(line)}</span>`;
      }
    }).join('\n');
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Pulling public image state
  pullImageName = new FormControl('redis:alpine');
  pullLogs = signal<string[]>([]);
  isPulling = signal<boolean>(false);

  // Form group for launching containers
  launchForm: FormGroup;

  // Form for creating Volumes / Networks
  volumeForm: FormGroup;
  networkForm: FormGroup;

  // Active Terminal IO State
  termInput = new FormControl('');
  termLines = signal<string[]>([]);
  @ViewChild('terminalBox') terminalBox?: ElementRef;

  // State Stores (Signals)
  images = signal<DockerImage[]>([]);
  containers = signal<DockerContainer[]>([]);
  volumes = signal<DockerVolume[]>([]);
  networks = signal<DockerNetwork[]>([]);

  // Simulation Update Loop Timer
  private stateTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.launchForm = this.fb.group({
      name: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9_-]+$/)]],
      image: ['', Validators.required],
      hostPort: [8080, [Validators.min(1024), Validators.max(65535)]],
      network: ['bridge'],
      envString: ['NODE_ENV=production,DEBUG=app:*'],
      volumeName: [''],
      volumeMountPath: ['']
    });

    this.volumeForm = this.fb.group({
      name: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9_-]+$/)]],
      driver: ['local']
    });

    this.networkForm = this.fb.group({
      name: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9_-]+$/)]],
      driver: ['bridge'],
      subnet: ['172.19.0.0/16']
    });

    // Seed Initial State
    this.seedDefaultState();

    // Start Real-time Worker (Updates CPU/Memory stats dynamically)
    this.startSimulationTick();

    // Monitor template selections to swap default Dockerfiles
    effect(() => {
      const templ = this.selectedTemplate();
      this.loadTemplateDockerfile(templ);
    });

    // D3 real-time metrics tracker effect
    effect(() => {
      // Read the total metrics reactively
      const cpu = this.totalCpuUsage();
      const mem = this.totalMemUsage();
      const tab = this.activeTab();
      this.selectedMetricType();

      if (tab !== 'dashboard' && tab !== 'workspace') return;

      const newPoint = {
        timestamp: new Date(),
        cpu: cpu,
        memory: mem
      };

      this.hostStatsHistory.push(newPoint);
      if (this.hostStatsHistory.length > 25) {
        this.hostStatsHistory.shift();
      }

      // Schedule canvas update
      setTimeout(() => this.updateD3Charts(), 50);
    });

    // Monaco editor synchronization & initialization effect
    effect(() => {
      this.dockerfileInput();
      const tab = this.activeTab();
      const subTab = this.editorSubTab();

      if (typeof window !== 'undefined') {
        if (tab === 'workspace' && subTab === 'edit') {
          setTimeout(() => {
            this.initMonacoForce();
          }, 100);
        } else {
          this.disposeMonaco();
        }
      }
    });

    // Real-time Monaco editor validation markers sync effect
    effect(() => {
      this.dockerfileErrors();
      this.updateMonacoMarkers();
    });

    // Auto-scroll build logs on live stream updates
    effect(() => {
      this.buildLogs();
      if (typeof document !== 'undefined') {
        setTimeout(() => {
          const container = document.getElementById('console-logs-container');
          if (container) {
            container.scrollTop = container.scrollHeight;
          }
        }, 30);
      }
    });
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private monacoEditorInstance: any = null;

  loadMonaco(): Promise<any> {
    if (typeof window === 'undefined') {
      return Promise.reject('SSR Environment');
    }
    if ((window as any).monaco) {
      return Promise.resolve((window as any).monaco);
    }
    return new Promise((resolve, reject) => {
      if ((window as any).require) {
        (window as any).require.config({
          paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }
        });
        (window as any).require(['vs/editor/editor.main'], () => {
          resolve((window as any).monaco);
        });
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs/loader.js';
      script.onload = () => {
        (window as any).require.config({
          paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' }
        });
        (window as any).require(['vs/editor/editor.main'], () => {
          resolve((window as any).monaco);
        });
      };
      script.onerror = reject;
      document.body.appendChild(script);
    });
  }

  initMonacoForce(): void {
    if (typeof window === 'undefined') return;
    const container = document.getElementById('monaco-editor-container');
    if (!container) return;

    if (this.monacoEditorInstance) {
      const val = this.dockerfileInput();
      if (this.monacoEditorInstance.getValue() !== val) {
        this.monacoEditorInstance.setValue(val);
      }
      return;
    }

    this.loadMonaco().then((monaco) => {
      const updatedContainer = document.getElementById('monaco-editor-container');
      if (!updatedContainer) return;

      this.monacoEditorInstance = monaco.editor.create(updatedContainer, {
        value: this.dockerfileInput(),
        language: 'dockerfile',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        cursorBlinking: 'smooth',
        scrollbar: {
          vertical: 'visible',
          horizontal: 'visible'
        },
        padding: { top: 8, bottom: 8 }
      });

      this.monacoEditorInstance.onDidChangeModelContent(() => {
        const val = this.monacoEditorInstance.getValue();
        if (this.dockerfileInput() !== val) {
          this.dockerfileInput.set(val);
        }
        this.updateMonacoMarkers();
      });

      this.updateMonacoMarkers();
    }).catch(err => {
      console.error('Error loading monaco editor', err);
    });
  }

  updateMonacoMarkers(): void {
    if (typeof window !== 'undefined' && this.monacoEditorInstance) {
      const monaco = (window as any).monaco;
      if (monaco) {
        const model = this.monacoEditorInstance.getModel();
        if (model) {
          const errors = this.dockerfileErrors();
          const markers = errors.map(err => {
            const lineContent = model.getLineContent(err.line) || '';
            const startColumn = 1;
            const endColumn = lineContent.length + 1;
            
            return {
              severity: err.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
              message: `${err.message} (${err.tip})`,
              startLineNumber: err.line,
              startColumn: startColumn,
              endLineNumber: err.line,
              endColumn: endColumn
            };
          });
          monaco.editor.setModelMarkers(model, 'dockerfile-linter', markers);
        }
      }
    }
  }

  disposeMonaco(): void {
    if (this.monacoEditorInstance) {
      this.monacoEditorInstance.dispose();
      this.monacoEditorInstance = null;
    }
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  ngAfterViewInit() {
    this.scrollToTerminalBottom();
    this.initResizeObserver();
    
    // Automatically select first running container for workspace terminal if none selected
    if (!this.terminalContainer()) {
      const running = this.containers().find(c => c.status === 'running');
      if (running) {
        this.openTerminal(running);
      }
    }
  }

  ngOnDestroy() {
    if (this.stateTimer) {
      clearInterval(this.stateTimer);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    this.disposeMonaco();
  }

  // --- Seed Initial Docker Environment ---
  private seedDefaultState() {
    // 1. Volumes
    const defaultVolumes: DockerVolume[] = [
      {
        name: 'database-records',
        driver: 'local',
        scope: 'local',
        created: new Date().toISOString(),
        files: {
          'user_data.json': JSON.stringify([
            { id: 1, name: 'Alice', active: true },
            { id: 2, name: 'Bob', active: false }
          ], null, 2),
          'config.ini': '[postgresql]\nmax_connections = 100\nshared_buffers = 128MB'
        }
      },
      {
        name: 'web-assets',
        driver: 'local',
        scope: 'local',
        created: new Date().toISOString(),
        files: {
          'widget.js': '// Client UI elements widget\nconsole.log("widget connected");',
          'styles-extra.css': 'body { background: #000; }'
        }
      }
    ];
    this.volumes.set(defaultVolumes);

    // 2. Default Networks
    const defaultNetworks: DockerNetwork[] = [
      { id: 'n1', name: 'bridge', driver: 'bridge', subnet: '172.17.0.0/16', gateway: '172.17.0.1', containers: [] },
      { id: 'n2', name: 'host', driver: 'host', subnet: '0.0.0.0/0', gateway: '0.0.0.0', containers: [] },
      { id: 'n3', name: 'none', driver: 'none', subnet: '', gateway: '', containers: [] }
    ];
    this.networks.set(defaultNetworks);

    // 3. Built-in Base Images
    const baseImages: DockerImage[] = [
      {
        id: 'img-nginx-alpine',
        tag: 'nginx:alpine',
        size: '23.4 MB',
        created: '12 days ago',
        isPrebuilt: true,
        layers: ['FROM alpine:3.18', 'RUN apk add --no-cache nginx', 'COPY index.html /usr/share/nginx/html/', 'EXPOSE 80', 'CMD ["nginx", "-g", "daemon off;"]'],
        dockerfile: '# Prebuilt Official Nginx Image\nFROM alpine:3.18\nRUN apk add --no-cache nginx\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]',
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
        workdir: '/',
        ports: [80],
        cmd: 'nginx -g daemon off;',
        filesystem: {
          '/': { type: 'dir' },
          '/usr': { type: 'dir' },
          '/usr/share': { type: 'dir' },
          '/usr/share/nginx': { type: 'dir' },
          '/usr/share/nginx/html': { type: 'dir' },
          '/usr/share/nginx/html/index.html': {
            type: 'file',
            content: `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Welcome to Nginx!</title>
  <style>
    body { font-family: 'Inter', sans-serif; background-color: #0f172a; color: #f8fafc; padding: 4rem; text-align: center; }
    h1 { color: #38bdf8; font-size: 2.5rem; font-weight: 600; margin-bottom: 1rem; }
    p { color: #94a3b8; line-height: 1.6; max-width: 500px; margin: 0 auto 1.5rem; }
    .badge { background-color: #0369a1; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.85rem; display: inline-block; font-family: monospace; }
  </style>
</head>
<body>
  <h1>🐳 Docker-Nginx Connected</h1>
  <p>Your simulated container is serving web assets flawlessly inside this local network bridge!</p>
  <div class="badge">IP: 172.17.0.2 | Port: 80</div>
</body>
</html>`
          },
          '/etc': { type: 'dir' },
          '/etc/nginx': { type: 'dir' },
          '/etc/nginx/nginx.conf': { type: 'file', content: '# Nginx standard config\nevents { worker_connections 1024; }\nhttp {\n  server {\n    listen 80;\n    root /usr/share/nginx/html;\n  }\n}' },
          '/bin': { type: 'dir' },
          '/bin/sh': { type: 'file', content: '# Shell executable' }
        }
      },
      {
        id: 'img-node-alpine',
        tag: 'node:18-alpine',
        size: '122.1 MB',
        created: '3 weeks ago',
        isPrebuilt: true,
        layers: ['FROM alpine:3.18', 'RUN apk add --no-cache nodejs npm', 'WORKDIR /app', 'EXPOSE 3000'],
        dockerfile: '# Prebuilt Node.js Sandbox\nFROM alpine:3.18\nRUN apk add --no-cache nodejs npm\nWORKDIR /app',
        env: { NODE_ENV: 'development', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
        workdir: '/app',
        ports: [3000],
        cmd: 'node',
        filesystem: {
          '/': { type: 'dir' },
          '/app': { type: 'dir' },
          '/app/package.json': {
            type: 'file',
            content: JSON.stringify({
              name: "docker-node-api",
              version: "1.0.0",
              main: "app.js",
              dependencies: { express: "^4.18.2" }
            }, null, 2)
          },
          '/app/app.js': {
            type: 'file',
            content: `const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    engine: "node-express",
    uptime: process.uptime(),
    host: "Simulated-Node-Container",
    status: "Healthy",
    time: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
    features: ["Virtual DNS", "Bridge Routing", "Cross-Container Fetch", "Dynamic Memory Persistence"]
  });
});

app.listen(PORT, () => {
  console.log('⚡ Node.js API Service booted inside Container on port ' + PORT);
});`
          },
          '/usr': { type: 'dir' },
          '/usr/bin': { type: 'dir' },
          '/usr/bin/node': { type: 'file', content: '# Simulated NodeJS Interpreter' },
          '/usr/bin/npm': { type: 'file', content: '# Simulated Node Package Manager' },
          '/bin': { type: 'dir' },
          '/bin/sh': { type: 'file', content: '# Shell executable' }
        }
      },
      {
        id: 'img-postgres-alpine',
        tag: 'postgres:15-alpine',
        size: '228.4 MB',
        created: '1 month ago',
        isPrebuilt: true,
        layers: ['FROM alpine:3.18', 'RUN apk add --no-cache postgresql', 'ENV PGUSER=postgres', 'EXPOSE 5432', 'VOLUME /var/lib/postgresql/data'],
        dockerfile: '# PostgreSQL alpine prebuilt\nFROM alpine:3.18\nRUN apk add postgresql\nENV PGUSER=postgres\nEXPOSE 5432',
        env: { PGDATA: '/var/lib/postgresql/data', PGUSER: 'postgres', POSTGRES_DB: 'dock_db' },
        workdir: '/var/lib/postgresql',
        ports: [5432],
        cmd: 'postgres',
        filesystem: {
          '/': { type: 'dir' },
          '/var': { type: 'dir' },
          '/var/lib': { type: 'dir' },
          '/var/lib/postgresql': { type: 'dir' },
          '/var/lib/postgresql/data': { type: 'dir' },
          '/usr/bin': { type: 'dir' },
          '/usr/bin/postgres': { type: 'file', content: '# Postgres engine binary' },
          '/bin/sh': { type: 'file', content: '# Shell executable' }
        }
      },
      {
        id: 'img-python-slim',
        tag: 'python:3.10-slim',
        size: '115.0 MB',
        created: '2 months ago',
        isPrebuilt: true,
        layers: ['FROM debian:bookworm-slim', 'RUN apt-get update && apt-get install -y python3', 'EXPOSE 8000'],
        dockerfile: '# Prebuilt Python Interpreter\nFROM debian:bookworm-slim\nRUN apt-get update && apt-get install python3\nEXPOSE 8000',
        env: { PYTHONUNBUFFERED: '1' },
        workdir: '/',
        ports: [8000],
        cmd: 'python3 -m http.server 8000',
        filesystem: {
          '/': { type: 'dir' },
          '/app': { type: 'dir' },
          '/app/main.py': {
            type: 'file',
            content: `import sys\nimport time\n\nprint("🐍 Starting Simulated Python Server...")\nprint("Python version:", sys.version)\nwhile True:\n    print("Tick:", time.time())\n    time.sleep(10)`
          },
          '/usr/bin': { type: 'dir' },
          '/usr/bin/python3': { type: 'file', content: '# Python runtime executable' },
          '/bin/sh': { type: 'file', content: '# Shell executable' }
        }
      }
    ];
    this.images.set(baseImages);

    // 4. Default Running Containers
    const defaultContainers: DockerContainer[] = [
      {
        id: 'c8cf2e176b91',
        name: 'web-nginx',
        imageId: 'img-nginx-alpine',
        imageTag: 'nginx:alpine',
        status: 'running',
        exitCode: 0,
        created: new Date().toISOString(),
        ports: { 8080: 80 },
        ipAddress: '172.17.0.2',
        network: 'bridge',
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
        workdir: '/',
        currentWorkdir: '/usr/share/nginx/html',
        volumes: [],
        stats: { cpu: 0.1, memory: 14.8, memoryLimit: 512, netIn: 1.4, netOut: 24.5 },
        logs: [
          { stream: 'system', text: 'Initializing worker processes...', time: new Date().toISOString() },
          { stream: 'stdout', text: '[notice] 1#1: using the "epoll" event method', time: new Date().toISOString() },
          { stream: 'stdout', text: '[notice] 1#1: nginx/1.25.1', time: new Date().toISOString() },
          { stream: 'stdout', text: '[notice] 1#1: built by gcc 12.2.1', time: new Date().toISOString() },
          { stream: 'stdout', text: '[notice] 1#1: start worker process 32', time: new Date().toISOString() },
          { stream: 'stdout', text: 'nginx is running and listening on port 80 🚀', time: new Date().toISOString() }
        ],
        filesystem: JSON.parse(JSON.stringify(baseImages[0].filesystem)),
        history: [],
        cmd: 'nginx -g daemon off;'
      },
      {
        id: 'fa821cd35189',
        name: 'api-service',
        imageId: 'img-node-alpine',
        imageTag: 'node:18-alpine',
        status: 'running',
        exitCode: 0,
        created: new Date().toISOString(),
        ports: { 3000: 3000 },
        ipAddress: '172.17.0.3',
        network: 'bridge',
        env: { NODE_ENV: 'production', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
        workdir: '/app',
        currentWorkdir: '/app',
        volumes: [],
        stats: { cpu: 1.2, memory: 44.2, memoryLimit: 1024, netIn: 12.8, netOut: 112.4 },
        logs: [
          { stream: 'system', text: 'Booting Node environment...', time: new Date().toISOString() },
          { stream: 'stdout', text: '> docker-node-api@1.0.0 start', time: new Date().toISOString() },
          { stream: 'stdout', text: '> node app.js', time: new Date().toISOString() },
          { stream: 'stdout', text: '⚡ Node.js API Service booted inside Container on port 3000', time: new Date().toISOString() }
        ],
        filesystem: JSON.parse(JSON.stringify(baseImages[1].filesystem)),
        history: [],
        cmd: 'node app.js'
      }
    ];

    // Connect them in networks
    defaultNetworks[0].containers.push('c8cf2e176b91', 'fa821cd35189');

    this.containers.set(defaultContainers);

    // Pick first image for launching form default
    this.launchForm.patchValue({
      image: baseImages[0].id
    });
  }

  // Swap default Dockerfiles based on sidebar click
  loadTemplateDockerfile(template: string) {
    if (template === 'node') {
      this.dockerfileInput.set(`FROM node:18-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "app.js"]`);
      this.newImageTag.setValue('my-node-service:latest');
    } else if (template === 'nginx') {
      this.dockerfileInput.set(`FROM nginx:alpine
COPY . /usr/share/nginx/html/
ENV CACHE_HOURS=24
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]`);
      this.newImageTag.setValue('my-nginx-web:latest');
    } else if (template === 'postgres') {
      this.dockerfileInput.set(`FROM postgres:15-alpine
ENV POSTGRES_DB=dev_db
ENV POSTGRES_PASSWORD=adminpwd
VOLUME /var/lib/postgresql/data
EXPOSE 5432
CMD ["postgres"]`);
      this.newImageTag.setValue('my-database:latest');
    } else if (template === 'python') {
      this.dockerfileInput.set(`FROM python:3.10-slim
WORKDIR /server
COPY app.py ./
ENV ENV_MODE=production
EXPOSE 8000
CMD ["python3", "-m", "http.server", "8000"]`);
      this.newImageTag.setValue('my-py-server:latest');
    }
  }

  // --- Statistics simulation interval loop ---
  private startSimulationTick() {
    this.stateTimer = setInterval(() => {
      this.containers.update(currentArr => {
        return currentArr.map(container => {
          if (container.status !== 'running') {
            return {
              ...container,
              stats: { cpu: 0, memory: 0, memoryLimit: container.stats.memoryLimit, netIn: container.stats.netIn, netOut: container.stats.netOut }
            };
          }
          // Random walk stats update
          const seedBase = container.imageTag.includes('nginx') ? 0.3 : 2.5;
          const cpuDelta = (Math.random() - 0.5) * 0.4 + seedBase * 0.05;
          const targetCpu = Math.max(0.05, Math.min(65.0, container.stats.cpu + cpuDelta));

          const memoryDelta = (Math.random() - 0.5) * 1.5;
          const targetMem = Math.max(4.0, Math.min(container.stats.memoryLimit, container.stats.memory + memoryDelta));

          const randomReq = Math.random() > 0.6;
          const netInDelta = randomReq ? Math.floor(Math.random() * 8) : 0;
          const netOutDelta = randomReq ? Math.floor(Math.random() * 45) : 0;

          // Add simple logging sometimes if container is active to mock output activity
          const updatedLogs = [...container.logs];
          if (randomReq && container.imageTag.includes('nginx') && Math.random() > 0.8) {
            const pathOption = ['/', '/api/items', '/dist/bundle.js', '/favicon.ico'];
            const randomPath = pathOption[Math.floor(Math.random() * pathOption.length)];
            const remoteHost = `172.17.0.${Math.round(Math.random() * 4 + 1)}`;
            const timestamp = new Date().toISOString();
            updatedLogs.push({
              stream: 'stdout',
              text: `${remoteHost} - - [${new Date().toLocaleDateString()}] "GET ${randomPath} HTTP/1.1" 200 ${Math.round(Math.random() * 1200 + 400)}`,
              time: timestamp
            });
            // cap logs length max 100 for safety
            if (updatedLogs.length > 80) updatedLogs.shift();
          }

          return {
            ...container,
            stats: {
              cpu: parseFloat(targetCpu.toFixed(1)),
              memory: parseFloat(targetMem.toFixed(1)),
              memoryLimit: container.stats.memoryLimit,
              netIn: container.stats.netIn + netInDelta,
              netOut: container.stats.netOut + netOutDelta
            },
            logs: updatedLogs
          };
        });
      });
    }, 1200);
  }

  // --- Helper: Simulate filesystem directory details ---
  getFilesInDirectory(container: DockerContainer, dirPath: string): { name: string; type: 'file' | 'dir'; size?: string }[] {
    const fs = container.filesystem;
    const normDir = dirPath === '/' ? '/' : (dirPath.endsWith('/') ? dirPath : dirPath + '/');
    const filesList: { name: string; type: 'file' | 'dir'; size?: string }[] = [];
    const directChildren = new Set<string>();

    for (const p of Object.keys(fs)) {
      if (p === dirPath) continue;
      
      const inDir = dirPath === '/' 
        ? p.startsWith('/') && p.slice(1).split('/').length === 1
        : p.startsWith(normDir) && p.slice(normDir.length).split('/').length === 1;

      if (inDir) {
        const name = dirPath === '/' ? p.substring(1) : p.substring(normDir.length);
        if (name) {
          filesList.push({
            name,
            type: fs[p].type,
            size: fs[p].type === 'file' ? `${(fs[p].content?.length || 0) + 12} B` : undefined
          });
          directChildren.add(name);
        }
      } else if (p.startsWith(normDir)) {
        // Nested subdirectories
        const remainder = p.substring(normDir.length);
        const firstPart = remainder.split('/')[0];
        if (firstPart && !directChildren.has(firstPart)) {
          filesList.push({
            name: firstPart,
            type: 'dir'
          });
          directChildren.add(firstPart);
        }
      }
    }
    return filesList.sort((a,b) => (b.type === 'dir' ? 1 : 0) - (a.type === 'dir' ? 1 : 0) || a.name.localeCompare(b.name));
  }

  // --- Simulated Container Engine Actions ---
  toggleContainer(containerId: string) {
    this.containers.update(list => list.map(c => {
      if (c.id === containerId) {
        const newStatus = c.status === 'running' ? 'stopped' : 'running';
        const timestamp = new Date().toISOString();
        const logs = [...c.logs];
        logs.push({
          stream: 'system',
          text: newStatus === 'running' 
            ? `container started successfully: command '${c.cmd}'` 
            : `container stopped peacefully.`,
          time: timestamp
        });
        return {
          ...c,
          status: newStatus,
          logs
        };
      }
      return c;
    }));
  }

  restartContainer(containerId: string) {
    this.containers.update(list => list.map(c => {
      if (c.id === containerId) {
        const timestamp = new Date().toISOString();
        const logs = [...c.logs];
        logs.push(
          { stream: 'system', text: `sending SIGTERM to container processes...`, time: timestamp },
          { stream: 'system', text: `restarting container cleanly...`, time: timestamp },
          { stream: 'stdout', text: `reboot successful!`, time: timestamp }
        );
        return {
          ...c,
          status: 'running',
          logs
        };
      }
      return c;
    }));
  }

  deleteContainer(containerId: string) {
    const activeTerm = this.terminalContainer();
    if (activeTerm?.id === containerId) this.terminalContainer.set(null);
    const activeLog = this.logsContainer();
    if (activeLog?.id === containerId) this.logsContainer.set(null);

    this.containers.update(list => list.filter(c => c.id !== containerId));
    
    // Disconnect container from network registry mapping
    this.networks.update(nets => nets.map(net => ({
      ...net,
      containers: net.containers.filter(id => id !== containerId)
    })));
  }

  // Launch simulated container using Launch Form settings
  launchContainer() {
    if (this.launchForm.invalid) return;

    const data = this.launchForm.value;
    const selectedImageId = data.image;
    const image = this.images().find(img => img.id === selectedImageId);
    if (!image) return;

    // Build ID
    const containerId = Math.random().toString(36).substring(2, 14);
    
    // Parse environment strings
    const envObj = { ...image.env };
    if (data.envString) {
      data.envString.split(',').forEach((sub: string) => {
        const [k, v] = sub.split('=');
        if (k && v) envObj[k.trim()] = v.trim();
      });
    }

    // Allocate random unique Container IP
    const bridgeNet = this.networks().find(n => n.name === data.network);
    const existingIps = this.containers().map(c => c.ipAddress);
    let ip = '172.17.0.10';
    if (bridgeNet && bridgeNet.subnet.startsWith('172.')) {
      const subPrefix = bridgeNet.subnet.split('.').slice(0,3).join('.'); // e.g., 172.17.0
      for (let i = 4; i < 254; i++) {
        const candidateIp = `${subPrefix}.${i}`;
        if (!existingIps.includes(candidateIp)) {
          ip = candidateIp;
          break;
        }
      }
    }

    // Capture volume mount configuration
    const volumeMounts: VolumeMount[] = [];
    const initialFS = JSON.parse(JSON.stringify(image.filesystem));

    if (data.volumeName && data.volumeMountPath) {
      volumeMounts.push({
        volumeName: data.volumeName,
        containerPath: data.volumeMountPath
      });

      // Synchronize initial files from DockerVolume host repository directory if it contains records
      const hostVolume = this.volumes().find(v => v.name === data.volumeName);
      if (hostVolume) {
        // Ensure parent directories exist
        const pathsToCreate = data.volumeMountPath.split('/').filter(Boolean);
        let currPath = '';
        pathsToCreate.forEach((p: string) => {
          currPath += '/' + p;
          if (!initialFS[currPath]) {
            initialFS[currPath] = { type: 'dir' };
          }
        });

        // Seed with volume files
        Object.keys(hostVolume.files).forEach(fPath => {
          const fullPath = data.volumeMountPath + (fPath.startsWith('/') ? fPath : '/' + fPath);
          initialFS[fullPath] = {
            type: 'file',
            content: hostVolume.files[fPath]
          };
        });
      }
    }

    const newContainer: DockerContainer = {
      id: containerId,
      name: data.name,
      imageId: image.id,
      imageTag: image.tag,
      status: 'running',
      exitCode: 0,
      created: new Date().toISOString(),
      ports: { [data.hostPort]: image.ports[0] || 80 },
      ipAddress: ip,
      network: data.network,
      env: envObj,
      workdir: image.workdir || '/',
      currentWorkdir: image.workdir || '/',
      volumes: volumeMounts,
      stats: { cpu: 0.1, memory: 18.0, memoryLimit: 512, netIn: 0.1, netOut: 0.1 },
      logs: [
        { stream: 'system', text: `Container successfully provisioned with hostname '${data.name}'`, time: new Date().toISOString() },
        { stream: 'system', text: `Assigned static subnet interface: ${ip}`, time: new Date().toISOString() },
        { stream: 'system', text: `Publishing host port interface ${data.hostPort}:${image.ports[0] || 80}`, time: new Date().toISOString() },
        { stream: 'system', text: `CMD target: [${image.cmd}]`, time: new Date().toISOString() },
        { stream: 'stdout', text: `Initiating startup sequence for service on PID 1...`, time: new Date().toISOString() }
      ],
      filesystem: initialFS,
      history: [],
      cmd: image.cmd,
      installedPackages: []
    };

    // Auto append logs based on service tags
    if (image.tag.includes('node')) {
      newContainer.logs.push(
        { stream: 'stdout', text: `⚡ Node.js API Service booted inside Container on port ${image.ports[0] || 3000}`, time: new Date().toISOString() }
      );
    } else if (image.tag.includes('nginx')) {
      newContainer.logs.push(
        { stream: 'stdout', text: `nginx is running and listening on port ${image.ports[0] || 80} 🚀`, time: new Date().toISOString() }
      );
    } else if (image.tag.includes('postgres')) {
      newContainer.logs.push(
        { stream: 'stdout', text: `2026-06-22 14:43:55.105 UTC [1] LOG: database system is ready to accept connections`, time: new Date().toISOString() }
      );
    }

    // Append to Docker Containers Store
    this.containers.update(list => [...list, newContainer]);

    // Append network container index pointer
    this.networks.update(nets => nets.map(net => {
      if (net.name === data.network) {
        return { ...net, containers: [...net.containers, containerId] };
      }
      return net;
    }));

    // Reset Form Fields with randomized clean variables
    this.launchForm.reset({
      name: 'service-' + Math.floor(Math.random() * 900 + 100),
      image: selectedImageId,
      hostPort: Math.floor(Math.random() * 4000 + 4000),
      network: 'bridge',
      envString: 'NODE_ENV=production',
      volumeName: '',
      volumeMountPath: ''
    });

    // Automatically navigate view panel back to Containers lists
    this.activeTab.set('containers');
  }

  // --- VOLUME CREATION ENGINE ---
  createVolume() {
    if (this.volumeForm.invalid) return;
    const data = this.volumeForm.value;

    const volumeExists = this.volumes().some(v => v.name === data.name);
    if (volumeExists) {
      alert(`Volume of name ${data.name} already exists.`);
      return;
    }

    const newVolume: DockerVolume = {
      name: data.name,
      driver: data.driver || 'local',
      scope: 'local',
      created: new Date().toISOString(),
      files: {
        'metadata.json': JSON.stringify({ description: "Persistent client store database folder", files: 0 }, null, 2)
      }
    };

    this.volumes.update(arr => [...arr, newVolume]);
    this.volumeForm.reset({
      name: '',
      driver: 'local'
    });
  }

  deleteVolume(volName: string) {
    this.volumes.update(arr => arr.filter(v => v.name !== volName));
  }

  // --- NETWORK CREATION ENGINE ---
  createNetwork() {
    if (this.networkForm.invalid) return;
    const data = this.networkForm.value;

    const netExists = this.networks().some(n => n.name === data.name);
    if (netExists) {
      alert(`Network of name ${data.name} already exists.`);
      return;
    }

    // Determine random Gateway IP for the subnet
    const ipParts = data.subnet.split('.');
    const gatewayIp = `${ipParts[0]}.${ipParts[1]}.0.1`;

    const newNet: DockerNetwork = {
      id: 'net-' + Math.random().toString(36).substring(2, 8),
      name: data.name,
      driver: data.driver || 'bridge',
      subnet: data.subnet,
      gateway: gatewayIp,
      containers: []
    };

    this.networks.update(arr => [...arr, newNet]);
    this.networkForm.reset({
      name: '',
      driver: 'bridge',
      subnet: '172.22.0.0/16'
    });
  }

  deleteNetwork(netId: string) {
    const netObj = this.networks().find(n => n.id === netId);
    if (netObj && ['bridge', 'host', 'none'].includes(netObj.name)) {
      alert("Cannot delete standard default configurations.");
      return;
    }
    this.networks.update(arr => arr.filter(n => n.id !== netId));
  }

  // --- DRAG-AND-DROP NETWORK TOPOLOGY CONTROLS ---
  draggedContainerId = signal<string | null>(null);
  activeDropTargetNetworkId = signal<string | null>(null);

  onContainerDragStart(event: DragEvent, containerId: string) {
    this.draggedContainerId.set(containerId);
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', containerId);
      event.dataTransfer.effectAllowed = 'move';
    }
  }

  onContainerDragEnd() {
    this.draggedContainerId.set(null);
    this.activeDropTargetNetworkId.set(null);
  }

  onNetworkDragOver(event: DragEvent, networkId: string) {
    event.preventDefault();
    if (this.draggedContainerId() && this.activeDropTargetNetworkId() !== networkId) {
      this.activeDropTargetNetworkId.set(networkId);
    }
  }

  onNetworkDragLeave() {
    this.activeDropTargetNetworkId.set(null);
  }

  onNetworkDrop(event: DragEvent, targetNetworkName: string) {
    event.preventDefault();
    const containerId = event.dataTransfer?.getData('text/plain') || this.draggedContainerId();
    if (containerId) {
      this.moveContainerToNetwork(containerId, targetNetworkName);
    }
    this.draggedContainerId.set(null);
    this.activeDropTargetNetworkId.set(null);
  }

  moveContainerToNetwork(containerId: string, targetNetworkName: string) {
    const container = this.containers().find(c => c.id === containerId);
    if (!container) return;

    if (container.network === targetNetworkName) {
      return; // Already in this network
    }

    const targetNet = this.networks().find(n => n.name === targetNetworkName);
    if (!targetNet) return;

    const oldNetworkName = container.network;

    // Generate new IP address conformant to target subnet
    const existingIps = this.containers().map(c => c.ipAddress);
    let newIp = '172.17.0.10';
    if (targetNet.subnet && targetNet.subnet.startsWith('172.')) {
      const subPrefix = targetNet.subnet.split('.').slice(0, 3).join('.');
      for (let i = 4; i < 254; i++) {
        const candidateIp = `${subPrefix}.${i}`;
        if (!existingIps.includes(candidateIp)) {
          newIp = candidateIp;
          break;
        }
      }
    } else {
      const randSegment = Math.floor(Math.random() * 80 + 18);
      newIp = `172.${randSegment}.0.${Math.floor(Math.random() * 200 + 4)}`;
    }

    // Update container signal
    this.containers.update(list => list.map(c => {
      if (c.id === containerId) {
        const updatedLogs = [
          ...c.logs,
          {
            stream: 'system' as const,
            text: `[DOCKER NETWORK ROUTER] Migrated network bridge interface from '${oldNetworkName}' to '${targetNetworkName}'`,
            time: new Date().toISOString()
          },
          {
            stream: 'system' as const,
            text: `Allocated route IP endpoint: ${newIp}`,
            time: new Date().toISOString()
          }
        ];
        return {
          ...c,
          network: targetNetworkName,
          ipAddress: newIp,
          logs: updatedLogs
        };
      }
      return c;
    }));

    // Update networks signal
    this.networks.update(nets => nets.map(net => {
      let nextContainers = net.containers || [];
      if (net.name === oldNetworkName) {
        nextContainers = nextContainers.filter(id => id !== containerId);
      }
      if (net.name === targetNetworkName) {
        if (!nextContainers.includes(containerId)) {
          nextContainers = [...nextContainers, containerId];
        }
      }
      return { ...net, containers: nextContainers };
    }));
  }

  // --- DOCKERFILE PARSING & BUILDING (STEPPED SIMULATOR) ---
  simulateBuild() {
    if (this.isBuilding()) return;

    const tag = this.newImageTag.value;
    if (!tag) {
      this.buildLogs.set(['🔴 Error: Please specify a target tag (e.g., node-app:latest)']);
      return;
    }

    this.isBuilding.set(true);
    this.buildProgress.set(2);
    this.buildLogs.set([]);
    this.buildTimeElapsed.set(0);
    this.activeBuildStepIndex.set(0);

    // Parse main lines from Editor signal, ignoring empty links and comment lines
    const dockerfileRaw = this.dockerfileInput();
    const cleanLines = dockerfileRaw.split('\n')
      .map(l => l.trim())
      .filter(line => line !== '' && !line.startsWith('#'));

    if (cleanLines.length === 0) {
      this.buildLogs.set(['🔴 Error: Dockerfile has no action instructions.']);
      this.isBuilding.set(false);
      return;
    }

    // Set timeline steps info reactive array
    this.buildTimelineSteps.set(cleanLines.map((line, idx) => {
      const spaceIdx = line.indexOf(' ');
      const inst = spaceIdx > 0 ? line.substring(0, spaceIdx) : line;
      const args = spaceIdx > 0 ? line.substring(spaceIdx + 1) : '';
      return {
        index: idx + 1,
        instruction: inst,
        arguments: args,
        status: 'pending' as const
      };
    }));

    const cacheEvaluation = this.cacheService.evaluateDockerfileCache(dockerfileRaw);

    // Set up ticking log ticker timer
    let elapsedMs = 0;
    const ticker = setInterval(() => {
      elapsedMs += 100;
      this.buildTimeElapsed.set(elapsedMs / 1000);
    }, 100);

    // Build standard event stream queue
    interface QueueItem {
      type: 'log' | 'progress' | 'step_status' | 'complete';
      text?: string;
      progress?: number;
      stepIdx?: number;
      stepStatus?: 'pending' | 'running' | 'completed' | 'cached';
      stepHash?: string;
    }

    const queue: QueueItem[] = [];

    // Handshake entries
    queue.push({ type: 'log', text: 'Sending build context to Docker daemon  3.584 kB' });
    queue.push({ type: 'progress', progress: 5 });
    queue.push({ type: 'log', text: '[Docker Daemon Engine] Parsing local multi-stage instructions...' });
    queue.push({ type: 'log', text: '[Docker Cache System] Evaluating layer dependency hashes...' });
    queue.push({ type: 'progress', progress: 10 });

    // Loop through instructions and construct line-by-line console logs
    cleanLines.forEach((line, idx) => {
      const cacheStatus = cacheEvaluation[idx];
      const isCacheHit = cacheStatus && cacheStatus.status === 'hit';
      const spaceIdx = line.indexOf(' ');
      const inst = spaceIdx > 0 ? line.substring(0, spaceIdx) : line;
      const args = spaceIdx > 0 ? line.substring(spaceIdx + 1) : '';
      const upperInst = inst.toUpperCase();

      if (isCacheHit) {
        queue.push({ type: 'step_status', stepIdx: idx, stepStatus: 'running' });
        queue.push({ type: 'progress', progress: Math.min(95, Math.round(((idx + 0.2) / cleanLines.length) * 100)) });
        queue.push({ type: 'log', text: `Step ${idx + 1}/${cleanLines.length} : ${line}` });
        queue.push({ type: 'log', text: ` ---> Using cache [${cacheStatus.hash || 'md5-cached-layer'}]` });
        if (cacheStatus.cachedFromImageTag) {
          queue.push({ type: 'log', text: ` ---> Restored file index context from image: ${cacheStatus.cachedFromImageTag}` });
        }
        queue.push({ type: 'step_status', stepIdx: idx, stepStatus: 'cached', stepHash: cacheStatus.hash || 'md5-cached-layer' });
      } else {
        queue.push({ type: 'step_status', stepIdx: idx, stepStatus: 'running' });
        queue.push({ type: 'progress', progress: Math.min(95, Math.round(((idx + 0.2) / cleanLines.length) * 100)) });
        queue.push({ type: 'log', text: `Step ${idx + 1}/${cleanLines.length} : ${line}` });

        if (upperInst === 'FROM') {
          queue.push({ type: 'log', text: ` ---> Pulling image layers from secure library...` });
          queue.push({ type: 'log', text: ` ---> Layer [ea345b12]: Pulling fs segment [40%]` });
          queue.push({ type: 'log', text: ` ---> Layer [ea345b12]: Pulling fs segment [85%]` });
          queue.push({ type: 'log', text: ` ---> Layer [ea345b12]: Pull complete` });
          queue.push({ type: 'log', text: ` ---> Layer [f7823e11]: Pull complete` });
          queue.push({ type: 'log', text: ` ---> Base image checksum: sha256:d81347072c...` });
        } else if (upperInst === 'WORKDIR') {
          queue.push({ type: 'log', text: ` ---> Creating custom directory partition mounts...` });
          queue.push({ type: 'log', text: ` ---> Working root target context initialized: ${args}` });
        } else if (upperInst === 'RUN') {
          if (args.includes('npm install') || args.includes('yarn')) {
            queue.push({ type: 'log', text: ` ---> Bootstrapping project development module tree...` });
            queue.push({ type: 'log', text: `npm info run package.json compile metadata parse` });
            queue.push({ type: 'log', text: `npm http fetch GET https://registry.npmjs.org/express...` });
            queue.push({ type: 'log', text: `npm http 200 https://registry.npmjs.org/express` });
            queue.push({ type: 'log', text: `added 28 dependency packages in 1.1s` });
          } else if (args.includes('apk add') || args.includes('apt-get')) {
            queue.push({ type: 'log', text: ` ---> Retrieving alpine repository configurations...` });
            queue.push({ type: 'log', text: `fetch http://dl-cdn.alpinelinux.org/alpine/v3.18/main/x86_64/APKINDEX.tar.gz` });
            queue.push({ type: 'log', text: `Installing libc-dev, bash, build-essentials` });
            queue.push({ type: 'log', text: `OK: packages installed cleanly, layout size 6.1MB` });
          } else {
            queue.push({ type: 'log', text: ` ---> Executing subshell instruction: ${args}` });
            queue.push({ type: 'log', text: `[Docker Engine Output] Command exit code 0` });
          }
        } else if (upperInst === 'COPY') {
          queue.push({ type: 'log', text: ` ---> Parsing local workspace source repositories...` });
          queue.push({ type: 'log', text: ` ---> Imported 18 project files to virtual volume container (18.6 kB)` });
        } else if (upperInst === 'ENV') {
          queue.push({ type: 'log', text: ` ---> Binding environment variables in active pipeline namespace` });
        } else if (upperInst === 'EXPOSE') {
          queue.push({ type: 'log', text: ` ---> Exposing virtual proxy networking bridge port on host mapping list` });
        } else {
          queue.push({ type: 'log', text: ` ---> Resolved compiler layout signature instruction` });
        }

        const stepHash = 'layer-' + Math.random().toString(16).substring(2, 10);
        queue.push({ type: 'log', text: ` ---> ${stepHash}` });
        queue.push({ type: 'step_status', stepIdx: idx, stepStatus: 'completed', stepHash });
      }
    });

    // Complete target compilation item
    queue.push({ type: 'complete' });

    // Process queue actions smoothly
    const processQueue = () => {
      if (queue.length === 0) {
        clearInterval(ticker);
        this.isBuilding.set(false);
        this.activeBuildStepIndex.set(-1);
        return;
      }

      const item = queue.shift()!;

      if (item.type === 'log' && item.text) {
        this.buildLogs.update(logs => [...logs, item.text!]);
      } else if (item.type === 'progress' && item.progress !== undefined) {
        this.buildProgress.set(item.progress);
      } else if (item.type === 'step_status' && item.stepIdx !== undefined && item.stepStatus) {
        this.activeBuildStepIndex.set(item.stepIdx);
        this.buildTimelineSteps.update(steps => {
          const next = [...steps];
          if (next[item.stepIdx!]) {
            next[item.stepIdx!].status = item.stepStatus!;
            if (item.stepHash) {
              next[item.stepIdx!].hash = item.stepHash;
            }
          }
          return next;
        });
      } else if (item.type === 'complete') {
        clearInterval(ticker);

        // Form custom environment variables compiled from the Dockerfile
        const compiledEnv: Record<string, string> = {};
        const exposedPorts: number[] = [];
        let cmdStr = 'node';
        let customWorkdir = '/';

        // Mock simple filesystem output for Dockerfile custom directories
        const mockFS: FileSystem = {
          '/': { type: 'dir' }
        };

        cleanLines.forEach(inst => {
          if (inst.startsWith('ENV ')) {
            const body = inst.substring(4).trim();
            const equalIndex = body.indexOf('=');
            if (equalIndex > 0) {
              const k = body.substring(0, equalIndex).trim();
              const v = body.substring(equalIndex + 1).trim();
              compiledEnv[k] = v;
            } else {
              const parts = body.split(/\s+/);
              if (parts[0]) compiledEnv[parts[0]] = parts.slice(1).join(' ');
            }
          } else if (inst.startsWith('EXPOSE ')) {
            const portNum = parseInt(inst.substring(7).trim());
            if (!isNaN(portNum)) exposedPorts.push(portNum);
          } else if (inst.startsWith('CMD ')) {
            cmdStr = inst.substring(4).trim();
            cmdStr = cmdStr.replace('[', '').replace(']', '').replace(/"/g, '').replace(/,/g, ' ');
          } else if (inst.startsWith('WORKDIR ')) {
            customWorkdir = inst.substring(8).trim();
            mockFS[customWorkdir] = { type: 'dir' };
          }
        });

        // Seed basic contents
        mockFS[customWorkdir + '/package.json'] = {
          type: 'file',
          content: '{\n  "name": "custom-compiled-docker",\n  "status": "compiled-from-scratch"\n}'
        };
        mockFS[customWorkdir + '/app.js'] = {
          type: 'file',
          content: `console.log("Custom app listening on ports: ${exposedPorts.join(',') || 'none'}");`
        };

        const imageId = 'img-' + Math.random().toString(36).substring(2, 10);
        const newImageObj: DockerImage = {
          id: imageId,
          tag: tag,
          size: `${Math.round(Math.random() * 40 + 60)}.8 MB`,
          created: 'Just now',
          isPrebuilt: false,
          layers: cleanLines,
          dockerfile: dockerfileRaw,
          env: compiledEnv,
          workdir: customWorkdir,
          ports: exposedPorts.length > 0 ? exposedPorts : [3000],
          cmd: cmdStr,
          filesystem: mockFS
        };

        this.images.update(arr => [...arr, newImageObj]);

        // Register build to update cache statistics
        const report = this.cacheService.registerBuildAndFlushCache(imageId, tag, dockerfileRaw, cleanLines);

        // Auto selection in launching container
        this.launchForm.patchValue({ image: imageId });

        this.buildLogs.update(logsArr => [
          ...logsArr,
          `Removing intermediate container daemon...`,
          ` ---> Successfully built ${imageId.replace('img-', '')}`,
          ` ---> Successfully tagged ${tag}`,
          ` ---> Cache Savings: ${report.cachedLayersCount} of ${report.totalLayers} layers hit (${Math.round((report.cachedLayersCount / report.totalLayers) * 100)}% Cache rate)`,
          ` ---> Size Saved: ${report.sizeSavedMb} MB | Estimated build-time saved: ${report.timeSavedSeconds}s`,
          `🟢 Build completed successfully!`
        ]);

        this.buildProgress.set(100);
        this.isBuilding.set(false);
        this.activeBuildStepIndex.set(-1);
        return;
      }

      // Read cache status for dynamic delays
      const isCurrentlyCached = item.stepIdx !== undefined && cacheEvaluation[item.stepIdx]?.status === 'hit';
      const delay = isCurrentlyCached ? 45 : 190;
      setTimeout(processQueue, delay);
    };

    // Trigger process executor
    setTimeout(processQueue, 350);
  }

  deleteImage(imgId: string) {
    const imgObj = this.images().find(img => img.id === imgId);
    if (imgObj?.isPrebuilt) {
      alert("Cannot delete prebuilt official Docker images.");
      return;
    }
    this.images.update(arr => arr.filter(i => i.id !== imgId));
  }

  // --- REGISTRY WORKGROUND - PULLING STANDARD IMAGE ---
  pullOfficialImage() {
    if (this.isPulling()) return;
    const name = this.pullImageName.value;
    if (!name) return;

    this.isPulling.set(true);
    this.pullLogs.set([
      `Using default tag: latest`,
      `Pulling from library/${name.includes(':') ? name.split(':')[0] : name}`,
      `9b1429811c7d: Pulling fs layer`,
      `0d19de42b936: Pulling fs layer`
    ]);

    let step = 0;
    const pullTick = () => {
      if (step === 0) {
        this.pullLogs.update(arr => [...arr, `9b1429811c7d: Downloading [===============>                                   ]  4.2MB/12.4MB`]);
      } else if (step === 1) {
        this.pullLogs.update(arr => [...arr, `9b1429811c7d: Download complete`, `0d19de42b936: Extracting [==================================================>]  1.2MB/1.2MB`]);
      } else if (step === 2) {
        this.pullLogs.update(arr => [
          ...arr,
          `0d19de42b936: Pull complete`,
          `Digest: sha256:f12bf8e1e3b2b8c5a019dcfed9029910c2688b1cc96c2cf5ebcc3fcc25d0c732`,
          `Status: Downloaded newer image for ${name}`,
          `🟢 Successfully pulled image tag: ${name}`
        ]);

        // Add to images signal registry
        const baseName = name.includes(':') ? name : `${name}:latest`;
        const imageId = 'pull-' + Math.random().toString(36).substring(2, 10);
        
        const newPulledImage: DockerImage = {
          id: imageId,
          tag: baseName,
          size: `${Math.round(Math.random() * 32 + 12)} MB`,
          created: 'Just now pulled',
          isPrebuilt: false,
          layers: [`FROM ${baseName}`],
          dockerfile: `# Pulled from remote repository\nFROM ${baseName}`,
          env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
          workdir: '/',
          ports: [80],
          cmd: '/bin/sh',
          filesystem: {
            '/': { type: 'dir' },
            '/bin': { type: 'dir' },
            '/bin/sh': { type: 'file' }
          }
        };

        this.images.update(list => [...list, newPulledImage]);
        this.launchForm.patchValue({ image: imageId });
        this.isPulling.set(false);
        return;
      }
      step++;
      setTimeout(pullTick, 1000);
    };

    setTimeout(pullTick, 1000);
  }

  // --- INTERACTIVE BROWSER POPUP SIMULATOR ---
  // Demonstrates port forwarding of Docker perfectly to users!
  launchLocalBrowser(container: DockerContainer, hostPort: number) {
    this.webBrowserContainer.set(container);
    this.webBrowserHostPort.set(hostPort);
    
    // Evaluate response body based on image type and filesystem
    const targetPort = container.ports[hostPort] || 80;
    const fs = container.filesystem;

    if (container.imageTag.includes('nginx')) {
      // Return file content in /usr/share/nginx/html/index.html
      const file = fs['/usr/share/nginx/html/index.html'] || fs['/index.html'];
      this.webBrowserContent.set(file?.content || '<h2>Welcome to nginx!</h2><p>Default server listening on port 80</p>');
    } else if (container.imageTag.includes('node') || container.cmd.includes('node')) {
      // Mock Express JSON response
      this.webBrowserContent.set(`<pre style="background: #1e293b; color: #38bdf8; padding: 1.5rem; border-radius: 8px; font-family: monospace; overflow-x: auto;">
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Transfer-Encoding: chunked

${JSON.stringify({
  engine: "node-express-simulation",
  running: true,
  uptime: "420.52 seconds",
  container_ip: container.ipAddress,
  environment: container.env['NODE_ENV'] || 'development',
  message: "⚡ Hello World from inside your custom built Express microservice!",
  simulated_stats: {
    cpu: container.stats.cpu + "%",
    memory: container.stats.memory + " MB"
  }
}, null, 2)}
</pre>`);
    } else if (container.imageTag.includes('python')) {
      // Simple directory listings standard of python http server
      this.webBrowserContent.set(`<html>
<head><title>Directory listing for /</title></head>
<body style="font-family: monospace; padding: 2rem; background: #fafafa;">
<h2>Directory listing for / inside container</h2>
<hr>
<ul>
  <li><a href="#">app/</a></li>
  <li><a href="#">bin/</a></li>
  <li><a href="#">etc/</a></li>
  <li><a href="#">usr/</a></li>
  <li><a href="#">var/</a></li>
</ul>
<hr>
<p>Simulated Python HTTP server listening on bridge port ${targetPort}</p>
</body>
</html>`);
    } else {
      // General HTTP index catch
      this.webBrowserContent.set(`<div style="font-family: sans-serif; text-align: center; padding: 5rem 1rem; color: #64748b;">
        <span class="material-icons" style="font-size: 3.5rem; color: #94a3b8; margin-bottom: 1rem;">settings_ethernet</span>
        <h3 style="color: #475569; font-weight: 650;">Container TCP handshake successful</h3>
        <p style="font-size: 0.95rem; line-height: 1.5; color: #94a3b8;">Container IP resolved at ${container.ipAddress}:${targetPort}. Service listening but did not send HTTP payload response.</p>
      </div>`);
    }
  }

  closeLocalBrowser() {
    this.webBrowserContainer.set(null);
    this.webBrowserHostPort.set(null);
  }

  // --- TERMINAL EXEC INTERCTIVE CONSOLE (BASH CLI SYSTEM) ---
  openTerminal(container: DockerContainer) {
    this.terminalContainer.set(container);
    this.activeTab.set('containers');
    this.termActiveApp.set(null);
    this.termHistoryIndex = container.history?.length || 0;

    // Seed terminal console header
    this.termLines.set([
      `Microsoft Linux Core (Container Shell [ID: ${container.id.substring(0,6)}])`,
      `Default working directory: ${container.currentWorkdir}`,
      `Type 'help' to review list of simulated Docker diagnostic tools.`,
      `Commands: ps, apt-get, install, top, clear, cd, ls -la, ping, curl, tree, cowsay, figlet...`,
      `Host bridge loopback configured. Ping other container IP addresses to test bridge network routes.`,
      ` `
    ]);
    this.termInput.setValue('');
    setTimeout(() => this.scrollToTerminalBottom(), 100);
  }

  closeTerminal() {
    this.terminalContainer.set(null);
    this.termActiveApp.set(null);
  }

  changeTerminalConnection(containerId: string) {
    const target = this.containers().find(c => c.id === containerId && c.status === 'running');
    if (target) {
      this.openTerminal(target);
    }
  }

  navigateHistory(direction: 'up' | 'down', event: Event) {
    event.preventDefault();
    const container = this.terminalContainer();
    if (!container) return;
    if (!container.history) {
      container.history = [];
    }
    const len = container.history.length;
    if (len === 0) return;

    if (direction === 'up') {
      if (this.termHistoryIndex > 0) {
        this.termHistoryIndex--;
      }
    } else {
      if (this.termHistoryIndex < len) {
        this.termHistoryIndex++;
      }
    }

    if (this.termHistoryIndex >= 0 && this.termHistoryIndex < len) {
      this.termInput.setValue(container.history[this.termHistoryIndex]);
    } else {
      this.termInput.setValue('');
    }
  }

  private readonly dockerSubcommands = [
    'run', 'build', 'ps', 'images', 'exec', 'stop', 'start', 'restart', 'rm', 'rmi', 'logs', 'network', 'volume', 'info', 'version', 'compose'
  ];

  private readonly dockerFlags = {
    general: ['--help', '--version', '-H', '--host', '--debug', '-l', '--log-level'],
    run: ['-d', '--detach', '--name', '-p', '--publish', '-v', '--volume', '-e', '--env', '--network', '--rm', '-it', '--restart', '--entrypoint', '-h', '--hostname', '-u', '--user', '-w', '--workdir'],
    build: ['-t', '--tag', '-f', '--file', '--no-cache', '--build-arg', '--pull', '--quiet', '-q', '--target'],
    ps: ['-a', '--all', '-q', '--quiet', '--filter', '--format', '--no-trunc', '-s', '--size'],
    images: ['-a', '--all', '-q', '--quiet', '--digests', '--format', '--no-trunc'],
    exec: ['-it', '-d', '--detach', '-u', '--user', '-w', '--workdir', '-e', '--env'],
    stop: ['-t', '--time'],
    logs: ['-f', '--follow', '--tail', '-t', '--timestamps', '--since'],
    network: ['create', 'inspect', 'ls', 'rm', 'prune', 'connect', 'disconnect'],
    volume: ['create', 'inspect', 'ls', 'rm', 'prune']
  };

  triggerAutoComplete(event: Event) {
    event.preventDefault();
    const container = this.terminalContainer();
    if (!container) return;

    const val = this.termInput.value || '';
    const trimmedVal = val.trim();
    const hasTrailingSpace = val.endsWith(' ');
    const tokens = trimmedVal.split(/\s+/);

    if (tokens.length > 0 && tokens[0].toLowerCase() === 'docker') {
      // 1. Docker command autocomplete
      if (tokens.length === 1) {
        // Just typed "docker"
        if (hasTrailingSpace) {
          // Suggest subcommands
          const prompt = `sh:${container.currentWorkdir} # ${val}`;
          const possibilities = this.dockerSubcommands.join('   ');
          this.termLines.update(arr => [...arr, `${prompt}`, possibilities, ' ']);
          setTimeout(() => this.scrollToTerminalBottom(), 50);
        } else {
          // auto-append space of "docker "
          this.termInput.setValue('docker ');
        }
        return;
      }

      const subCmd = tokens[1].toLowerCase();

      // Typing the subcommand itself (e.g. "docker r" with no trailing space)
      if (tokens.length === 2 && !hasTrailingSpace) {
        const lastToken = tokens[1];
        const matches = this.dockerSubcommands.filter(s => s.startsWith(lastToken));
        if (matches.length === 1) {
          tokens[1] = matches[0] + ' ';
          this.termInput.setValue(tokens.join(' '));
        } else if (matches.length > 1) {
          const prompt = `sh:${container.currentWorkdir} # ${val}`;
          const possibilities = matches.join('   ');
          this.termLines.update(arr => [...arr, `${prompt}`, possibilities, ' ']);
          setTimeout(() => this.scrollToTerminalBottom(), 50);
        }
        return;
      }

      // Past the subcommand (either has trailing space or typing active flags/args)
      const flagsForSub = (this.dockerFlags as Record<string, string[]>)[subCmd] || this.dockerFlags.general;

      if (hasTrailingSpace) {
        // Suggest common flags for this subcommand
        const prompt = `sh:${container.currentWorkdir} # ${val}`;
        const possibilities = flagsForSub.join('   ');
        this.termLines.update(arr => [...arr, `${prompt}`, possibilities, ' ']);
        setTimeout(() => this.scrollToTerminalBottom(), 50);
        return;
      } else {
        const lastToken = tokens[tokens.length - 1];
        if (lastToken.startsWith('-')) {
          const matches = flagsForSub.filter(f => f.startsWith(lastToken));
          if (matches.length === 1) {
            tokens[tokens.length - 1] = matches[0] + ' ';
            this.termInput.setValue(tokens.join(' '));
          } else if (matches.length > 1) {
            const prompt = `sh:${container.currentWorkdir} # ${val}`;
            const possibilities = matches.join('   ');
            this.termLines.update(arr => [...arr, `${prompt}`, possibilities, ' ']);
            setTimeout(() => this.scrollToTerminalBottom(), 50);
          }
          return;
        } else {
          // Dynamic completion of container names or image tags
          if (['stop', 'start', 'restart', 'logs', 'exec', 'rm'].includes(subCmd)) {
            const contNames = this.containers().map(c => c.name);
            const matches = contNames.filter(name => name.startsWith(lastToken));
            if (matches.length === 1) {
              tokens[tokens.length - 1] = matches[0] + ' ';
              this.termInput.setValue(tokens.join(' '));
            } else if (matches.length > 1) {
              const prompt = `sh:${container.currentWorkdir} # ${val}`;
              const possibilities = matches.join('   ');
              this.termLines.update(arr => [...arr, `${prompt}`, possibilities, ' ']);
              setTimeout(() => this.scrollToTerminalBottom(), 50);
            }
            return;
          } else if (['run', 'rmi'].includes(subCmd)) {
            const images = this.images().map(i => i.tag);
            const matches = images.filter(t => t.startsWith(lastToken));
            if (matches.length === 1) {
              tokens[tokens.length - 1] = matches[0] + ' ';
              this.termInput.setValue(tokens.join(' '));
            } else if (matches.length > 1) {
              const prompt = `sh:${container.currentWorkdir} # ${val}`;
              const possibilities = matches.join('   ');
              this.termLines.update(arr => [...arr, `${prompt}`, possibilities, ' ']);
              setTimeout(() => this.scrollToTerminalBottom(), 50);
            }
            return;
          }
        }
      }
    }

    if (tokens.length === 0) return;
    const lastToken = tokens[tokens.length - 1];
    if (!lastToken) return;

    // 2. Fallback: Original file/directory autocomplete
    const files = this.getFilesInDirectory(container, container.currentWorkdir);
    const matches = files.filter(f => f.name.startsWith(lastToken));

    if (matches.length === 1) {
      tokens[tokens.length - 1] = matches[0].name + (matches[0].type === 'dir' ? '/' : '');
      this.termInput.setValue(tokens.join(' '));
    } else if (matches.length > 1) {
      const prompt = `sh:${container.currentWorkdir} # ${val}`;
      const possibilities = matches.map(m => m.name + (m.type === 'dir' ? '/' : '')).join('   ');
      this.termLines.update(arr => [...arr, `${prompt}`, possibilities, ' ']);
      setTimeout(() => this.scrollToTerminalBottom(), 50);
    }
  }

  executeTermCommand() {
    const cmdInput = this.termInput.value?.trim();
    if (!cmdInput) return;

    const container = this.terminalContainer();
    if (!container) return;

    // Reset shell input
    this.termInput.setValue('');

    // Update command history
    if (!container.history) {
      container.history = [];
    }
    if (container.history.length === 0 || container.history[container.history.length - 1] !== cmdInput) {
      container.history.push(cmdInput);
    }
    this.termHistoryIndex = container.history.length;

    // Append standard command echo
    const promptHeader = `sh:${container.currentWorkdir} # `;
    this.termLines.update(arr => [...arr, `${promptHeader}${cmdInput}`]);

    // Parse commands and parameters
    const tokens = cmdInput.split(/\s+/);
    const mainCmd = tokens[0].toLowerCase();
    const args = tokens.slice(1);

    // Command Router Logic
    let responseLines: string[] = [];

    switch (mainCmd) {
      case 'help':
        responseLines = [
          `Simulated Shell Tools available inside image [${container.imageTag}]:`,
          `  help                     Display helper tool catalog`,
          `  ls [dir]                 List directory files`,
          `  pwd                      Print active working path directory`,
          `  cd <dir>                 Change active working location`,
          `  cat <file>               Output contents of file`,
          `  mkdir <dir>              Provision target directory`,
          `  touch <file>             Ensure target empty file exists`,
          `  echo "content" [> file]  Print text string or map content to file`,
          `  env, printenv            Review active environment variables`,
          `  ping <ip_or_name>        Interrogate bridge node ping path latencies`,
          `  curl http://<ip>:<port>  Connect HTTP socket to target container IP subnet`,
          `  df -h, free -m           Display memory limits and storage capacities`,
          `  clear                    Flush terminal screen lines`
        ];
        break;

      case 'clear':
        this.termLines.set([]);
        return;

      case 'pwd':
        responseLines = [container.currentWorkdir];
        break;

      case 'cd': {
        const targetDir = args[0] || '/';
        let resolvedPath = targetDir;
        if (!targetDir.startsWith('/')) {
          const current = container.currentWorkdir === '/' ? '' : container.currentWorkdir;
          resolvedPath = `${current}/${targetDir}`;
        }
        // normalize dots and trailing slashes
        resolvedPath = resolvedPath.replace(/\/\.\//g, '/').replace(/\/+/g, '/');
        if (resolvedPath.endsWith('/') && resolvedPath.length > 1) {
          resolvedPath = resolvedPath.slice(0, -1);
        }

        // Validate directories exist inside the file-system dictionary structure
        const dirExists = container.filesystem[resolvedPath] && container.filesystem[resolvedPath].type === 'dir';
        if (dirExists || resolvedPath === '/') {
          // Update working directory state
          container.currentWorkdir = resolvedPath === '' ? '/' : resolvedPath;
          responseLines = [];
        } else {
          responseLines = [`cd: no such file or directory: ${targetDir}`];
        }
        break;
      }

      case 'ls': {
        const isLong = args.some(arg => arg.startsWith('-') && arg.includes('l'));
        const isAll = args.some(arg => arg.startsWith('-') && arg.includes('a'));
        const pathArgs = args.filter(arg => !arg.startsWith('-'));
        
        let lsTarget = pathArgs[0] || container.currentWorkdir;
        if (!lsTarget.startsWith('/')) {
          const current = container.currentWorkdir === '/' ? '' : container.currentWorkdir;
          lsTarget = `${current}/${lsTarget}`;
        }
        lsTarget = lsTarget.replace(/\/+/g, '/');
        if (lsTarget.endsWith('/') && lsTarget.length > 1) {
          lsTarget = lsTarget.slice(0, -1);
        }

        const files = this.getFilesInDirectory(container, lsTarget);
        if (isLong) {
          responseLines = [];
          if (isAll) {
            responseLines.push(`drwxr-xr-x   2 root     root          4096 Jun 22 15:10 .`);
            responseLines.push(`drwxr-xr-x   3 root     root          4096 Jun 22 15:10 ..`);
          }
          files.forEach(f => {
            const perm = f.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--';
            const links = f.type === 'dir' ? '2' : '1';
            const size = f.type === 'dir' ? '4096' : (f.size ? String(f.size).replace(' B', '') : '128');
            responseLines.push(`${perm}   ${links} root     root         ${size.padStart(5, ' ')} Jun 22 15:10 ${f.type === 'dir' ? f.name + '/' : f.name}`);
          });
        } else {
          let items = files.map(f => f.type === 'dir' ? `${f.name}/` : f.name);
          if (isAll) {
            items = ['.', '..', ...items];
          }
          responseLines = [items.join('   ')];
        }
        break;
      }

      case 'cat': {
        const catTarget = args[0];
        if (!catTarget) {
          responseLines = [`cat: Please specify target file path`];
          break;
        }
        let fullCatPath = catTarget;
        if (!catTarget.startsWith('/')) {
          const current = container.currentWorkdir === '/' ? '' : container.currentWorkdir;
          fullCatPath = `${current}/${catTarget}`;
        }
        fullCatPath = fullCatPath.replace(/\/+/g, '/');

        const fileRecord = container.filesystem[fullCatPath];
        if (fileRecord && fileRecord.type === 'file') {
          responseLines = (fileRecord.content || '').split('\n');
        } else {
          responseLines = [`cat: ${catTarget}: No such file or directory`];
        }
        break;
      }

      case 'touch': {
        const touchFile = args[0];
        if (!touchFile) {
          responseLines = [`touch: target file operand is required`];
          break;
        }
        let fullTouchPath = touchFile;
        if (!touchFile.startsWith('/')) {
          const current = container.currentWorkdir === '/' ? '' : container.currentWorkdir;
          fullTouchPath = `${current}/${touchFile}`;
        }
        fullTouchPath = fullTouchPath.replace(/\/+/g, '/');

        container.filesystem[fullTouchPath] = {
          type: 'file',
          content: '',
          size: 0
        };
        this.syncVolumeMount(container, fullTouchPath, '');
        responseLines = [];
        break;
      }

      case 'mkdir': {
        const newDir = args[0];
        if (!newDir) {
          responseLines = [`mkdir: directory path is required`];
          break;
        }
        let fullDirPath = newDir;
        if (!newDir.startsWith('/')) {
          const current = container.currentWorkdir === '/' ? '' : container.currentWorkdir;
          fullDirPath = `${current}/${newDir}`;
        }
        fullDirPath = fullDirPath.replace(/\/+/g, '/');

        container.filesystem[fullDirPath] = { type: 'dir' };
        responseLines = [];
        break;
      }

      case 'echo': {
        const echoInput = args.join(' ');
        // Check for redirects > or >>
        const rIndex = echoInput.indexOf('>');
        if (rIndex > 0) {
          const textRaw = echoInput.substring(0, rIndex).trim();
          const remains = echoInput.substring(rIndex).trim();
          const appendMode = remains.startsWith('>>');
          const fileRaw = remains.replace(/>+/g, '').trim();

          const textFinal = textRaw.replace(/^["']|["']$/g, ''); // strip quotes

          if (!fileRaw) {
            responseLines = [`bash: syntax error near unexpected token 'newline'`];
            break;
          }

          let fullEchoPath = fileRaw;
          if (!fileRaw.startsWith('/')) {
            const current = container.currentWorkdir === '/' ? '' : container.currentWorkdir;
            fullEchoPath = `${current}/${fileRaw}`;
          }
          fullEchoPath = fullEchoPath.replace(/\/+/g, '/');

          let existingContent = '';
          const prevFile = container.filesystem[fullEchoPath];
          if (prevFile && prevFile.type === 'file') {
            existingContent = prevFile.content || '';
          }

          const writtenContent = appendMode 
            ? (existingContent ? existingContent + '\n' + textFinal : textFinal)
            : textFinal;

          container.filesystem[fullEchoPath] = {
            type: 'file',
            content: writtenContent,
            size: writtenContent.length
          };

          this.syncVolumeMount(container, fullEchoPath, writtenContent);
          responseLines = [];
        } else {
          // simple echo out
          responseLines = [echoInput.replace(/^["']|["']$/g, '')];
        }
        break;
      }

      case 'env':
      case 'printenv':
        responseLines = Object.keys(container.env).map(k => `${k}=${container.env[k]}`);
        break;

      case 'df':
        responseLines = [
          `Filesystem           1K-blocks      Used Available Use% Mounted on`,
          `/dev/vdb               8256884    184288   7653456   3% /`,
          `tmpfs                   512000         0    512000   0% /dev`
        ];
        break;

      case 'free':
        responseLines = [
          `               total        used        free      shared  buff/cache   available`,
          `Mem:            ${container.stats.memoryLimit}          ${Math.round(container.stats.memory)}         ${Math.round(container.stats.memoryLimit - container.stats.memory)}           0          24         ${Math.round(container.stats.memoryLimit - container.stats.memory)}`
        ];
        break;

      case 'ping': {
        const dest = args[0];
        if (!dest) {
          responseLines = [`ping: target address is required`];
          break;
        }

        // Try lookup matching container name or IP address inside active network bridge lists
        const targetCont = this.containers().find(c => c.name === dest || c.ipAddress === dest);
        if (targetCont) {
          if (targetCont.status !== 'running') {
            responseLines = [
              `PING ${dest} (${targetCont.ipAddress}): 56 data bytes`,
              `Request timeout for icmp_seq 0`,
              `Request timeout for icmp_seq 1`,
              `--- ${dest} ping statistics ---`,
              `2 packets transmitted, 0 packets received, 100% packet loss`
            ];
          } else {
            responseLines = [
              `PING ${dest} (${targetCont.ipAddress}): 56 data bytes`,
              `64 bytes from ${targetCont.ipAddress}: icmp_seq=1 ttl=64 time=0.042 ms`,
              `64 bytes from ${targetCont.ipAddress}: icmp_seq=2 ttl=64 time=0.081 ms`,
              `--- ${dest} ping statistics ---`,
              `2 packets transmitted, 2 packets received, 0% packet loss, rtt min/avg/max = 0.042/0.061/0.081 ms`
            ];
          }
        } else {
          responseLines = [
            `PING ${dest} (${dest}): 56 data bytes`,
            `ping: sendto: Host is unreachable`,
            `--- ${dest} ping statistics ---`,
            `3 packets in route, 0 responses, 100% target fail`
          ];
        }
        break;
      }

      case 'curl': {
        const urlStr = args[0] || '';
        if (!urlStr) {
          responseLines = [`curl: target http URL is required (e.g., http://172.17.0.3)`];
          break;
        }
        // strip http prefix and extract host/port details
        const cleanedUrl = urlStr.replace('http://', '').replace('/', '');
        const hostParts = cleanedUrl.split(':');
        const hostNameIp = hostParts[0];
        const hostPortNum = parseInt(hostParts[1] || '80');

        const dnsNode = this.containers().find(c => c.name === hostNameIp || c.ipAddress === hostNameIp);
        if (dnsNode) {
          if (dnsNode.status !== 'running') {
            responseLines = [`curl: (7) Failed to connect to ${hostNameIp} port ${hostPortNum}: Connection refused`];
          } else {
            const htmlContent = dnsNode.filesystem['/usr/share/nginx/html/index.html'] || dnsNode.filesystem['/index.html'] || dnsNode.filesystem['/app/app.js'];
            responseLines = [
              `* Executing DNS bridge handshake lookup *`,
              `* Connecting successfully to host address tcp: [${dnsNode.ipAddress}:${hostPortNum}]`,
              `< HTTP/1.1 200 OK`,
              `< Content-Type: text/html`,
              `< Content-Length: ${htmlContent?.content?.length || 100}`,
              `< Server: Docker-Virtual-Router`,
              ` `,
              ...(htmlContent?.content || '').split('\n').slice(0, 15)
            ];
          }
        } else {
          responseLines = [
            `curl: (6) Could not resolve host: ${hostNameIp}`
          ];
        }
        break;
      }

      case 'ps': {
        const isAux = args.some(arg => arg.startsWith('-') && arg.includes('a')) || args.includes('aux');
        responseLines = [
          isAux 
            ? `USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND`
            : `  PID TTY          TIME CMD`
        ];

        const isNode = container.imageTag.includes('node');
        const isNginx = container.imageTag.includes('nginx');
        const isPostgres = container.imageTag.includes('postgres');

        if (isAux) {
          if (isNode) {
            responseLines.push(`root         1  0.2  1.4 550240 28620 ?        Ssl  15:09   0:02 npm run start`);
            responseLines.push(`root        15  0.8  4.2 812420 86104 ?        Sl   15:09   0:08 node app.js`);
          } else if (isNginx) {
            responseLines.push(`root         1  0.0  0.5  24840  9820 ?        Ss   15:09   0:00 nginx: master process nginx -g daemon off;`);
            responseLines.push(`nginx        6  0.1  0.3  25210  6480 ?        S    15:09   0:01 nginx: worker process`);
          } else if (isPostgres) {
            responseLines.push(`postgres     1  0.1  1.2 245120 24820 ?        Ss   15:09   0:01 postgres`);
            responseLines.push(`postgres    10  0.0  0.2 245120  4210 ?        Ss   15:09   0:00 postgres: checkpointer`);
            responseLines.push(`postgres    11  0.0  0.4 245120  8610 ?        Ss   15:09   0:00 postgres: background writer`);
            responseLines.push(`postgres    12  0.0  0.3 245120  6540 ?        Ss   15:09   0:00 postgres: walwriter`);
          } else {
            responseLines.push(`root         1  0.0  0.1   4250   920 ?        Ss   15:09   0:00 sh`);
          }
          responseLines.push(`root        42  0.0  0.0   2410   720 pts/0    R+   15:10   0:00 ps ${args.join(' ')}`);
        } else {
          if (isNode) {
            responseLines.push(`    1 pts/0    00:00:02 npm run start`);
            responseLines.push(`   15 pts/0    00:00:08 node`);
          } else if (isNginx) {
            responseLines.push(`    1 pts/0    00:00:00 nginx`);
            responseLines.push(`    6 pts/0    00:00:01 nginx`);
          } else if (isPostgres) {
            responseLines.push(`    1 pts/0    00:00:01 postgres`);
          } else {
            responseLines.push(`    1 pts/0    00:00:00 sh`);
          }
          responseLines.push(`   42 pts/0    00:00:00 ps`);
        }
        break;
      }

      case 'apt-get':
      case 'apt':
      case 'apk':
      case 'npm': {
        const subSub = args[0] || '';
        const targetPackage = args[1] || '';

        if ((mainCmd === 'apt-get' || mainCmd === 'apt') && subSub === 'install') {
          if (!targetPackage) {
            responseLines = [`apt-get: Please specify package target (e.g., htop, cowsay, figlet, tree)`];
            break;
          }
          this.simulatePackageInstallation(container, targetPackage);
          return;
        } else if (mainCmd === 'apk' && subSub === 'add') {
          if (!targetPackage) {
            responseLines = [`apk: Please specify package target (e.g., htop, cowsay, figlet, tree)`];
            break;
          }
          this.simulatePackageInstallation(container, targetPackage);
          return;
        } else if (mainCmd === 'npm' && subSub === 'install') {
          if (!targetPackage) {
            responseLines = [`npm: Please specify target module (e.g., express, lodash, chalk)`];
            break;
          }
          this.simulatePackageInstallation(container, targetPackage);
          return;
        } else {
          responseLines = [
            `Package Management Console for: ${container.imageTag}`,
            mainCmd === 'apk' ? `Usage: apk add <package>` : (mainCmd === 'npm' ? `Usage: npm install <package>` : `Usage: apt-get install <package>`),
            `Available virtual packages: htop, cowsay, figlet, tree, python3, git`
          ];
        }
        break;
      }

      case 'htop':
      case 'top': {
        const isInstalled = container.installedPackages?.includes('htop') || mainCmd === 'top';
        if (!isInstalled) {
          responseLines = [`bash: ${mainCmd}: command not found (Try running 'apt-get install htop' first!)`];
          break;
        }
        this.termActiveApp.set('htop');
        return;
      }

      case 'cowsay': {
        const isInstalled = container.installedPackages?.includes('cowsay');
        if (!isInstalled) {
          responseLines = [`bash: cowsay: command not found (Try running 'apt-get install cowsay' first!)`];
          break;
        }
        const text = args.join(' ') || 'Moo! Docker rules!';
        const border = '-'.repeat(text.length + 2);
        responseLines = [
          `  ${border}`,
          `  < ${text} >`,
          `  ${border}`,
          `         \\   ^__^`,
          `          \\  (oo)\\_______`,
          `             (__)\\       )\\/\\`,
          `                 ||----w |`,
          `                 ||     ||`
        ];
        break;
      }

      case 'figlet': {
        const isInstalled = container.installedPackages?.includes('figlet');
        if (!isInstalled) {
          responseLines = [`bash: figlet: command not found (Try running 'apt-get install figlet' first!)`];
          break;
        }
        const textToFig = (args.join(' ') || 'DOCKER').toUpperCase();
        responseLines = this.generateFigletASCII(textToFig);
        break;
      }

      case 'tree': {
        const isInstalled = container.installedPackages?.includes('tree');
        if (!isInstalled) {
          responseLines = [`bash: tree: command not found (Try running 'apt-get install tree' first!)`];
          break;
        }
        responseLines = this.generateTreeOutput(container, container.currentWorkdir);
        break;
      }

      case 'git': {
        const isInstalled = container.installedPackages?.includes('git');
        if (!isInstalled) {
          responseLines = [`bash: git: command not found (Try running 'apt-get install git' first!)`];
          break;
        }
        const gitCmd = args[0] || 'status';
        if (gitCmd === 'status') {
          responseLines = [
            `On branch main`,
            `Your branch is up to date with 'origin/main'.`,
            ` `,
            `Changes not staged for commit:`,
            `  (use "git add <file>..." to update what will be committed)`,
            `  (use "git restore <file>..." to discard changes in working directory)`,
            `	modified:   package.json`,
            ` `,
            `no changes added to commit (use "git add" and/or "git commit -a")`
          ];
        } else if (gitCmd === 'clone') {
          const repo = args[1] || 'https://github.com/nginx/nginx.git';
          responseLines = [
            `Cloning into '${repo.split('/').pop()?.replace('.git', '') || 'repo'}'...`,
            `remote: Enumerating objects: 1250, done.`,
            `remote: Counting objects: 100% (1250/1250), done.`,
            `remote: Compressing objects: 100% (802/802), done.`,
            `Receiving objects: 100% (1250/1250), 4.21 MiB | 2.15 MB/s, done.`,
            `Resolving deltas: 100% (415/415), done.`
          ];
        } else {
          responseLines = [
            `git: '${gitCmd}' is not a simulated git command. Try 'git status' or 'git clone'.`
          ];
        }
        break;
      }

      case 'docker': {
        const subSubCmd = args[0] || 'help';
        if (subSubCmd === 'ps') {
          const runconts = this.containers().filter(c => c.status === 'running');
          responseLines = [
            `CONTAINER ID   IMAGE                  COMMAND                  CREATED         STATUS         PORTS                    NAMES`,
          ];
          runconts.forEach(c => {
            const shortId = c.id.slice(0, 12);
            const truncatedImage = c.imageTag.substring(0, 20).padEnd(22, ' ');
            const truncatedCmd = (c.cmd || 'sh').substring(0, 23).padEnd(24, ' ');
            responseLines.push(`${shortId}   ${truncatedImage} "${truncatedCmd}"   A few mins ago   Up 4 minutes   0.0.0.0:80->80/tcp       ${c.name}`);
          });
          if (runconts.length === 0) {
            responseLines.push(`No containers currently running.`);
          }
        } else if (subSubCmd === 'images') {
          responseLines = [
            `REPOSITORY             TAG       IMAGE ID       CREATED         SIZE`,
          ];
          this.images().forEach(img => {
            const parts = img.tag.split(':');
            const repo = (parts[0] || img.tag).padEnd(22, ' ');
            const tag = (parts[1] || 'latest').padEnd(9, ' ');
            const shortId = img.id.slice(0, 12).padEnd(14, ' ');
            const createdVal = (img.created || '2 days ago').padEnd(14, ' ');
            const sizeVal = img.size || '128MB';
            responseLines.push(`${repo} ${tag} ${shortId} ${createdVal} ${sizeVal}`);
          });
        } else if (subSubCmd === 'version') {
          responseLines = [
            `Docker version 24.0.7, build afdd53b`,
            `API version:       1.43`,
            `Go version:        go1.20.10`,
            `Git commit:        afdd53b`,
            `Built:             Thu Oct 26 19:15:20 2023`,
            `OS/Arch:           linux/amd64`,
            `Context:           default`
          ];
        } else if (subSubCmd === 'info') {
          responseLines = [
            `Client:`,
            `  Context:    default`,
            `  Debug Mode: false`,
            `Server:`,
            `  Containers: ${this.containers().length}`,
            `    Running: ${this.runningContainersCount()}`,
            `    Paused: 0`,
            `    Stopped: ${this.stoppedContainersCount()}`,
            `  Images: ${this.images().length}`,
            `  Server Version: 24.0.7`,
            `  Storage Driver: overlay2`,
            `  Operating System: Alpine Linux (Simulated Container OS)`
          ];
        } else {
          responseLines = [
            `Simulated Docker CLI Gateway:`,
            `  docker ps              List active containers`,
            `  docker images          Print registered images`,
            `  docker version         Show API and build version`,
            `  docker info            Output deep daemon metrics`
          ];
        }
        break;
      }

      default:
        responseLines = [`sh: command not found: ${mainCmd}`];
        break;
    }

    this.termLines.update(arr => [...arr, ...responseLines, ' ']);
    setTimeout(() => this.scrollToTerminalBottom(), 80);
  }

  // Auto mirror filesystem writes into matching DockerVolume drivers (Local Sync)
  private syncVolumeMount(container: DockerContainer, filePath: string, newContent: string) {
    container.volumes.forEach(mount => {
      // Check if file path is within mounted path
      if (filePath.startsWith(mount.containerPath)) {
        // extract relative path inside volume
        let relPath = filePath.substring(mount.containerPath.length);
        if (relPath.startsWith('/')) relPath = relPath.slice(1);
        if (!relPath) relPath = 'index.html';

        this.volumes.update(arr => arr.map(vol => {
          if (vol.name === mount.volumeName) {
            const upFiles = { ...vol.files };
            upFiles[relPath] = newContent;
            return {
              ...vol,
              files: upFiles
            };
          }
          return vol;
        }));
      }
    });
  }

  scrollToTerminalBottom() {
    if (this.terminalBox) {
      try {
        const el = this.terminalBox.nativeElement;
        el.scrollTop = el.scrollHeight;
      } catch {
        void 0; // Safe no-op to satisfy empty block rule
      }
    }
  }

  simulatePackageInstallation(container: DockerContainer, pkg: string) {
    const pkgLower = pkg.toLowerCase();
    
    this.termLines.update(arr => [...arr, 
      `Reading package lists... Done`,
      `Building dependency tree... Done`,
      `Reading state information... Done`,
      `The following NEW packages will be installed:`,
      `  ${pkgLower}`,
      `0 upgraded, 1 newly installed, 0 to remove and 12 not upgraded.`,
      `Need to get 248 kB of archives.`,
      `After this operation, 984 kB of additional disk space will be used.`,
      `Get:1 http://dl-cdn.alpinelinux.org/alpine/v3.18/main ${pkgLower} [248 kB]`,
    ]);

    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
      if (ticks === 1) {
        this.termLines.update(arr => [...arr, `Connecting to dl-cdn.alpinelinux.org (151.101.86.133:80)...`]);
      } else if (ticks === 2) {
        this.termLines.update(arr => [...arr, `Downloaded 248 kB of ${pkgLower} packages.`]);
      } else if (ticks === 3) {
        this.termLines.update(arr => [...arr, 
          `Selecting previously unselected package ${pkgLower}.`,
          `Preparing to unpack .../${pkgLower}_all.apk ...`,
          `Unpacking ${pkgLower} (3.6.1-r0) ...`
        ]);
      } else if (ticks === 4) {
        this.termLines.update(arr => [...arr, 
          `Setting up ${pkgLower} ...`,
          `Verifying interface execution pointer layers...`
        ]);
      } else if (ticks === 5) {
        clearInterval(interval);
        
        // Add to installed registry
        if (!container.installedPackages) {
          container.installedPackages = [];
        }
        if (!container.installedPackages.includes(pkgLower)) {
          container.installedPackages.push(pkgLower);
        }

        // Add binary fake executable file to filesystem
        const binPath = `/usr/bin/${pkgLower}`;
        container.filesystem[binPath] = {
          type: 'file',
          content: `# Simulated bin executable for ${pkgLower}`,
          size: 1024
        };

        this.termLines.update(arr => [...arr, 
          `OK. Installed '${pkgLower}' successfully!`,
          `Type '${pkgLower}' to execute immediately.`,
          ` `
        ]);
        setTimeout(() => this.scrollToTerminalBottom(), 50);
      }
      setTimeout(() => this.scrollToTerminalBottom(), 50);
    }, 300);
  }

  generateFigletASCII(text: string): string[] {
    const font: Record<string, string[]> = {
      'A': ['  ████   ', ' ██  ██  ', '████████ ', '██    ██ '],
      'B': ['███████  ', '██    ██ ', '███████  ', '██    ██ ', '███████  '],
      'C': [' ██████  ', '██       ', '██       ', ' ██████  '],
      'D': ['██████   ', '██   ██  ', '██    ██ ', '██████   '],
      'E': ['████████ ', '██       ', '██████   ', '██       ', '████████ '],
      'F': ['████████ ', '██       ', '██████   ', '██       ', '██       '],
      'G': [' ██████  ', '██       ', '██   ███ ', ' ██████  '],
      'H': ['██    ██ ', '██    ██ ', '████████ ', '██    ██ ', '██    ██ '],
      'I': ['████████ ', '   ██    ', '   ██    ', '████████ '],
      'J': ['   █████ ', '     ██  ', '██   ██  ', ' █████   '],
      'K': ['██    ██ ', '██  ██   ', '█████    ', '██  ██   ', '██    ██ '],
      'L': ['██       ', '██       ', '██       ', '████████ '],
      'M': ['██    ██ ', '████████ ', '██ ██ ██ ', '██    ██ '],
      'N': ['██    ██ ', '████  ██ ', '██  ████ ', '██    ██ '],
      'O': [' ██████  ', '██    ██ ', '██    ██ ', ' ██████  '],
      'P': ['███████  ', '██    ██ ', '███████  ', '██       ', '██       '],
      'R': ['███████  ', '██    ██ ', '███████  ', '██  ██   ', '██    ██ '],
      'S': [' ██████  ', '██       ', ' ██████  ', '      ██ ', '███████  '],
      'T': ['████████ ', '   ██    ', '   ██    ', '   ██    '],
      'U': ['██    ██ ', '██    ██ ', '██    ██ ', ' ██████  '],
      'V': ['██    ██ ', '██    ██ ', ' ██  ██  ', '  ████   '],
      'W': ['██    ██ ', '██    ██ ', '██ ██ ██ ', '████████ '],
      'X': ['██    ██ ', ' ██  ██  ', '  ████   ', ' ██  ██  ', '██    ██ '],
      'Y': ['██    ██ ', ' ██  ██  ', '  ████   ', '  ████   '],
      'Z': ['████████ ', '    ██   ', '  ██     ', '████████ '],
      ' ': ['    ', '    ', '    ', '    ']
    };

    const lines = ['', '', '', '', ''];
    for (let i = 0; i < Math.min(text.length, 12); i++) {
      const char = text[i];
      const glyph = font[char] || ['██ ', '██ ', '██ ', '██ '];
      for (let r = 0; r < 4; r++) {
        lines[r] += (glyph[r] || '   ') + '  ';
      }
    }
    return lines;
  }

  generateTreeOutput(container: DockerContainer, rootPath: string): string[] {
    const fs = container.filesystem;
    const paths = Object.keys(fs).filter(p => p.startsWith(rootPath) && p !== rootPath);
    if (paths.length === 0) {
      return [`.`, `0 directories, 0 files`];
    }
    
    const lines = [rootPath];
    paths.sort().forEach(p => {
      const rel = p.substring(rootPath === '/' ? 1 : rootPath.length + 1);
      const segments = rel.split('/');
      const depth = segments.length;
      const name = segments[segments.length - 1];
      
      const indent = '│   '.repeat(depth - 1);
      const marker = '└── ';
      lines.push(`${indent}${marker}${name}`);
    });
    return lines;
  }

  openLogsPanel(container: DockerContainer) {
    this.logsContainer.set(container);
  }

  closeLogsPanel() {
    this.logsContainer.set(null);
  }

  // --- AI DOCKER COPILOT - CALL BACKEND GEMINI API ---
  async askCopilot() {
    const prompt = this.copilotInput.value?.trim();
    if (!prompt || this.copilotLoading()) return;

    this.copilotInput.setValue('');
    const userTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    this.copilotMessages.update(arr => [...arr, { role: 'user', text: prompt, time: userTime }]);
    this.copilotLoading.set(true);

    try {
      const response = await fetch('/api/docker/copilot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          prompt,
          systemInstruction: 'You are an elite, highly concise Docker and Kubernetes engineer. When requested to generate a Dockerfile, wrap it inside markdown block: ```dockerfile\\n...\\n```. Do not add unneeded fluff, be professional and highly operational.'
        })
      });

      if (!response.ok) {
        throw new Error('Copilot response error status: ' + response.status);
      }

      const resData = await response.json();
      const assistantTime = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      this.copilotMessages.update(arr => [...arr, {
        role: 'assistant',
        text: resData.text || "I apologize, but I received empty response data.",
        time: assistantTime
      }]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.copilotMessages.update(arr => [...arr, {
        role: 'assistant',
        text: `🔴 Connection error: Failed to reach Docker AI Copilot service. Please verify that your Secrets key environment is set. (${errMsg})`,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    } finally {
      this.copilotLoading.set(false);
    }
  }

  // Helper: Copy Dockerfile blocks from Copilot chat directly into compilation builder
  extractAndLoadDockerfile(text: string) {
    const rx = /```dockerfile([\s\S]*?)```/i;
    const match = rx.exec(text);
    if (match && match[1]) {
      this.dockerfileInput.set(match[1].trim());
      this.activeTab.set('images');
      alert("✅ Generated instructions extracted and loaded into Dockerfile editor!");
    } else {
      // try generic code block
      const genericRx = /```([\s\S]*?)```/;
      const genMatch = genericRx.exec(text);
      if (genMatch && genMatch[1] && genMatch[1].includes('FROM')) {
        this.dockerfileInput.set(genMatch[1].trim());
        this.activeTab.set('images');
        alert("✅ Generated instructions loaded into Dockerfile editor!");
      } else {
        alert("Could not locate a formatted Dockerfile code block in the message. Copy it manually.");
      }
    }
  }

  // --- D3.JS METRICS RENDER METHODS ---
  initResizeObserver() {
    if (typeof window === 'undefined') return;

    this.resizeObserver = new ResizeObserver(() => {
      this.updateD3Charts();
    });

    const elementsToObserve = [
      'd3-trend-wrapper',
      'd3-bars-wrapper',
      'd3-workspace-trend-wrapper',
      'd3-workspace-bars-wrapper'
    ];

    for (const id of elementsToObserve) {
      const el = document.getElementById(id);
      if (el) {
        this.resizeObserver.observe(el);
      }
    }
  }

  updateD3Charts() {
    this.renderTrendChart('#d3-trend-svg');
    this.renderTrendChart('#d3-workspace-trend-svg');
    this.renderBreakdownChart('#d3-bars-svg');
    this.renderBreakdownChart('#d3-workspace-bars-svg');
  }

  renderTrendChart(selector: string) {
    const svg = d3.select(selector);
    svg.selectAll('*').remove();

    if (this.hostStatsHistory.length === 0) {
      return;
    }

    const svgEl = svg.node() as SVGSVGElement | null;
    if (!svgEl) return;
    
    const container = svgEl.parentElement;
    if (!container) return;
    
    const width = container.clientWidth || 300;
    const height = container.clientHeight || 220;

    const margin = { top: 15, right: 40, bottom: 25, left: 40 };
    const contentWidth = width - margin.left - margin.right;
    const contentHeight = height - margin.top - margin.bottom;

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const defs = svg.append('defs');

    // CPU gradient
    const cpuGrad = defs.append('linearGradient')
      .attr('id', 'cpu-gradient')
      .attr('x1', '0%').attr('y1', '0%')
      .attr('x2', '0%').attr('y2', '100%');
    cpuGrad.append('stop').attr('offset', '0%').attr('stop-color', '#38bdf8').attr('stop-opacity', 0.22);
    cpuGrad.append('stop').attr('offset', '100%').attr('stop-color', '#38bdf8').attr('stop-opacity', 0);

    // Memory gradient
    const memGrad = defs.append('linearGradient')
      .attr('id', 'mem-gradient')
      .attr('x1', '0%').attr('y1', '0%')
      .attr('x2', '0%').attr('y2', '100%');
    memGrad.append('stop').attr('offset', '0%').attr('stop-color', '#10b981').attr('stop-opacity', 0.22);
    memGrad.append('stop').attr('offset', '100%').attr('stop-color', '#10b981').attr('stop-opacity', 0);

    // Scales
    const xDomain = d3.extent(this.hostStatsHistory, d => d.timestamp) as [Date, Date];
    const xScale = d3.scaleTime()
      .domain(xDomain)
      .range([0, contentWidth]);

    const maxCpuVal = d3.max(this.hostStatsHistory, d => d.cpu) || 10;
    const cpuMax = Math.max(100, maxCpuVal * 1.1);
    const yCpuScale = d3.scaleLinear()
      .domain([0, cpuMax])
      .range([contentHeight, 0]);

    const maxMemVal = d3.max(this.hostStatsHistory, d => d.memory) || 128;
    const memMax = Math.max(512, maxMemVal * 1.1);
    const yMemScale = d3.scaleLinear()
      .domain([0, memMax])
      .range([contentHeight, 0]);

    // Gridlines (based on CPU tick scale)
    const yTicks = yCpuScale.ticks(4);
    g.selectAll('.grid-line')
      .data(yTicks)
      .enter()
      .append('line')
      .attr('class', 'grid-line')
      .attr('x1', 0)
      .attr('x2', contentWidth)
      .attr('y1', d => yCpuScale(d))
      .attr('y2', d => yCpuScale(d))
      .attr('stroke', '#334155')
      .attr('stroke-width', 0.5)
      .attr('stroke-dasharray', '2,2')
      .attr('opacity', 0.4);

    const metricType = this.selectedMetricType();

    // 1. Draw CPU line/area
    if (metricType === 'both' || metricType === 'cpu') {
      const cpuArea = d3.area<{ timestamp: Date; cpu: number; memory: number }>()
        .x(d => xScale(d.timestamp))
        .y0(contentHeight)
        .y1(d => yCpuScale(d.cpu))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(this.hostStatsHistory)
        .attr('fill', 'url(#cpu-gradient)')
        .attr('d', cpuArea);

      const cpuLine = d3.line<{ timestamp: Date; cpu: number; memory: number }>()
        .x(d => xScale(d.timestamp))
        .y(d => yCpuScale(d.cpu))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(this.hostStatsHistory)
        .attr('fill', 'none')
        .attr('stroke', '#38bdf8')
        .attr('stroke-width', 2)
        .attr('d', cpuLine);

      // dot on last point
      const lp = this.hostStatsHistory[this.hostStatsHistory.length - 1];
      g.append('circle')
        .attr('cx', xScale(lp.timestamp))
        .attr('cy', yCpuScale(lp.cpu))
        .attr('r', 4)
        .attr('fill', '#38bdf8')
        .attr('stroke', '#020617')
        .attr('stroke-width', 1.5);
    }

    // 2. Draw Memory line/area
    if (metricType === 'both' || metricType === 'memory') {
      const memArea = d3.area<{ timestamp: Date; cpu: number; memory: number }>()
        .x(d => xScale(d.timestamp))
        .y0(contentHeight)
        .y1(d => yMemScale(d.memory))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(this.hostStatsHistory)
        .attr('fill', 'url(#mem-gradient)')
        .attr('d', memArea);

      const memLine = d3.line<{ timestamp: Date; cpu: number; memory: number }>()
        .x(d => xScale(d.timestamp))
        .y(d => yMemScale(d.memory))
        .curve(d3.curveMonotoneX);

      g.append('path')
        .datum(this.hostStatsHistory)
        .attr('fill', 'none')
        .attr('stroke', '#10b981')
        .attr('stroke-width', 2)
        .attr('d', memLine);

      // dot on last point
      const lp = this.hostStatsHistory[this.hostStatsHistory.length - 1];
      g.append('circle')
        .attr('cx', xScale(lp.timestamp))
        .attr('cy', yMemScale(lp.memory))
        .attr('r', 4)
        .attr('fill', '#10b981')
        .attr('stroke', '#020617')
        .attr('stroke-width', 1.5);
    }

    // X axis
    const formatTime = d3.timeFormat('%H:%M:%S');
    const xAxisGen = d3.axisBottom(xScale).ticks(5).tickFormat((d) => formatTime(d as Date));
    g.append('g')
      .attr('transform', `translate(0, ${contentHeight})`)
      .call(xAxisGen)
      .attr('font-size', '8px')
      .attr('font-style', 'italic')
      .attr('font-family', 'ui-monospace, SFMono-Regular, monospace')
      .call(g => g.select('.domain').attr('stroke', '#334155'))
      .call(g => g.selectAll('.tick line').attr('stroke', '#334155'))
      .call(g => g.selectAll('.tick text').attr('fill', '#64748b'));

    // Left Y axis (CPU scale)
    if (metricType === 'both' || metricType === 'cpu') {
      const yAxisLeft = d3.axisLeft(yCpuScale).ticks(4).tickFormat(d => `${d}%`);
      g.append('g')
        .call(yAxisLeft)
        .attr('font-size', '8px')
        .attr('font-family', 'ui-monospace, SFMono-Regular, monospace')
        .call(g => g.select('.domain').attr('stroke', '#334155'))
        .call(g => g.selectAll('.tick line').attr('stroke', '#334155'))
        .call(g => g.selectAll('.tick text').attr('fill', '#38bdf8'));
    }

    // Right Y axis (Mem scale)
    if (metricType === 'both' || metricType === 'memory') {
      const yAxisRight = d3.axisRight(yMemScale).ticks(4).tickFormat(d => `${d}M`);
      g.append('g')
        .attr('transform', `translate(${contentWidth}, 0)`)
        .call(yAxisRight)
        .attr('font-size', '8px')
        .attr('font-family', 'ui-monospace, SFMono-Regular, monospace')
        .call(g => g.select('.domain').attr('stroke', '#334155'))
        .call(g => g.selectAll('.tick line').attr('stroke', '#334155'))
        .call(g => g.selectAll('.tick text').attr('fill', '#10b981'));
    }
  }

  renderBreakdownChart(selector: string) {
    const svg = d3.select(selector);
    svg.selectAll('*').remove();

    const activeConts = this.runningContainers();
    if (activeConts.length === 0) {
      return;
    }

    const svgEl = svg.node() as SVGSVGElement | null;
    if (!svgEl) return;

    const container = svgEl.parentElement;
    if (!container) return;

    const width = container.clientWidth || 300;
    const height = container.clientHeight || 220;

    const margin = { top: 15, right: 40, bottom: 25, left: 110 };
    const contentWidth = width - margin.left - margin.right;
    const contentHeight = height - margin.top - margin.bottom;

    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const yScale = d3.scaleBand()
      .domain(activeConts.map(c => c.name))
      .range([0, contentHeight])
      .padding(0.28);

    const metricType = this.selectedMetricType();
    const subBarHeight = yScale.bandwidth() / 2 - 2;

    const maxCpu = Math.max(10, d3.max(activeConts, c => c.stats?.cpu || 0) || 5);
    const xCpuScale = d3.scaleLinear()
      .domain([0, maxCpu * 1.1])
      .range([0, contentWidth]);

    const maxMem = d3.max(activeConts, c => c.stats?.memory || 0) || 128;
    const xMemScale = d3.scaleLinear()
      .domain([0, Math.max(512, maxMem * 1.1)])
      .range([0, contentWidth]);

    // Row backgrounds
    g.selectAll('.row-bg')
      .data(activeConts)
      .enter()
      .append('rect')
      .attr('class', 'row-bg')
      .attr('x', 0)
      .attr('y', d => yScale(d.name) || 0)
      .attr('width', contentWidth)
      .attr('height', yScale.bandwidth())
      .attr('fill', '#1e293b')
      .attr('opacity', 0.2)
      .attr('rx', 4);

    // CPU Bars
    if (metricType === 'both' || metricType === 'cpu') {
      const yOffset = metricType === 'both' ? 2 : (yScale.bandwidth() / 4);
      const bHeight = metricType === 'both' ? subBarHeight : (yScale.bandwidth() / 2);

      g.selectAll('.cpu-bar')
        .data(activeConts)
        .enter()
        .append('rect')
        .attr('class', 'cpu-bar')
        .attr('x', 0)
        .attr('y', d => (yScale(d.name) || 0) + yOffset)
        .attr('width', d => xCpuScale(d.stats?.cpu || 0))
        .attr('height', bHeight)
        .attr('fill', '#38bdf8')
        .attr('rx', 1.5);

      g.selectAll('.cpu-bar-label')
        .data(activeConts)
        .enter()
        .append('text')
        .attr('class', 'cpu-bar-label')
        .attr('x', d => xCpuScale(d.stats?.cpu || 0) + 5)
        .attr('y', d => (yScale(d.name) || 0) + yOffset + bHeight / 2 + 3)
        .text(d => `${(d.stats?.cpu || 0).toFixed(1)}%`)
        .attr('fill', '#38bdf8')
        .attr('font-size', '8px')
        .attr('font-family', 'ui-monospace, SFMono-Regular, monospace')
        .attr('font-weight', 'medium');
    }

    // Memory Bars
    if (metricType === 'both' || metricType === 'memory') {
      const yOffset = metricType === 'both' ? (yScale.bandwidth() / 2 + 1) : (yScale.bandwidth() / 4);
      const bHeight = metricType === 'both' ? subBarHeight : (yScale.bandwidth() / 2);

      g.selectAll('.mem-bar')
        .data(activeConts)
        .enter()
        .append('rect')
        .attr('class', 'mem-bar')
        .attr('x', 0)
        .attr('y', d => (yScale(d.name) || 0) + yOffset)
        .attr('width', d => xMemScale(d.stats?.memory || 0))
        .attr('height', bHeight)
        .attr('fill', '#10b981')
        .attr('rx', 1.5);

      g.selectAll('.mem-bar-label')
        .data(activeConts)
        .enter()
        .append('text')
        .attr('class', 'mem-bar-label')
        .attr('x', d => xMemScale(d.stats?.memory || 0) + 5)
        .attr('y', d => (yScale(d.name) || 0) + yOffset + bHeight / 2 + 3)
        .text(d => `${(d.stats?.memory || 0).toFixed(1)}M`)
        .attr('fill', '#10b981')
        .attr('font-size', '8px')
        .attr('font-family', 'ui-monospace, SFMono-Regular, monospace')
        .attr('font-weight', 'medium');
    }

    // Container Names
    g.selectAll('.container-y-label')
      .data(activeConts)
      .enter()
      .append('text')
      .attr('class', 'container-y-label')
      .attr('x', -8)
      .attr('y', d => (yScale(d.name) || 0) + yScale.bandwidth() / 2 + 3)
      .attr('text-anchor', 'end')
      .text(d => d.name)
      .attr('fill', '#cbd5e1')
      .attr('font-size', '9px')
      .attr('font-family', 'ui-monospace, SFMono-Regular, monospace')
      .attr('font-weight', 'medium');

    // Bottom scale
    const targetScale = metricType === 'memory' ? xMemScale : xCpuScale;
    const bAxisGen = d3.axisBottom(targetScale)
      .ticks(4)
      .tickFormat(d => `${d}${metricType === 'memory' ? 'M' : '%'}`);

    g.append('g')
      .attr('transform', `translate(0, ${contentHeight})`)
      .call(bAxisGen)
      .attr('font-size', '7.5px')
      .attr('font-family', 'ui-monospace, SFMono-Regular, monospace')
      .call(g => g.select('.domain').attr('stroke', '#334155'))
      .call(g => g.selectAll('.tick line').attr('stroke', '#334155'))
      .call(g => g.selectAll('.tick text').attr('fill', '#475569'));
  }
}

import { 
  Component, 
  input, 
  model, 
  output, 
  effect, 
  ElementRef, 
  viewChild, 
  OnDestroy, 
  AfterViewInit,
  ChangeDetectionStrategy
} from '@angular/core';
import { ReactiveFormsModule, FormControl } from '@angular/forms';
import { MatIconModule } from '@angular/material/icon';

export interface DockerfileDiagnostics {
  line: number;
  instruction: string;
  severity: 'error' | 'warning';
  message: string;
  type: string;
  tip: string;
}

@Component({
  selector: 'app-dockerfile-editor',
  imports: [ReactiveFormsModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bg-[#080f1a] rounded-2xl border border-slate-800 overflow-hidden shadow-lg flex flex-col h-[650px]" id="workspace-editor-card">
      
      <!-- Column Header -->
      <div class="bg-[#0d182b] p-4 border-b border-slate-800 flex items-center justify-between">
        <div class="flex items-center gap-2">
          <mat-icon class="text-blue-400">code</mat-icon>
          <div class="text-left">
            <h3 class="text-sm font-bold text-slate-100">Dockerfile Workbench</h3>
            <p class="text-[10px] text-slate-400">Compile & custom-build images</p>
          </div>
        </div>
      </div>

      <!-- Boilerplate Selector Dropdown -->
      <div class="p-3 bg-slate-900/40 border-b border-slate-850 flex items-center justify-between gap-2">
        <span class="text-xs text-slate-300 font-medium">Load Template:</span>
        <div class="flex gap-1.5">
          <button (click)="loadTemplateFile('node')" 
            class="px-2 py-1 text-[10px] rounded border transition-colors cursor-pointer font-sans"
            [class.bg-blue-600]="selectedTemplate() === 'node'"
            [class.text-white]="selectedTemplate() === 'node'"
            [class.border-blue-500]="selectedTemplate() === 'node'"
            [class.bg-slate-800]="selectedTemplate() !== 'node'"
            [class.text-slate-300]="selectedTemplate() !== 'node'"
            [class.border-slate-700]="selectedTemplate() !== 'node'">
            Node.js
          </button>
          <button (click)="loadTemplateFile('nginx')" 
            class="px-2 py-1 text-[10px] rounded border transition-colors cursor-pointer font-sans"
            [class.bg-blue-600]="selectedTemplate() === 'nginx'"
            [class.text-white]="selectedTemplate() === 'nginx'"
            [class.border-blue-500]="selectedTemplate() === 'nginx'"
            [class.bg-slate-800]="selectedTemplate() !== 'nginx'"
            [class.text-slate-300]="selectedTemplate() !== 'nginx'"
            [class.border-slate-700]="selectedTemplate() !== 'nginx'">
            Nginx
          </button>
          <button (click)="loadTemplateFile('postgres')" 
            class="px-2 py-1 text-[10px] rounded border transition-colors cursor-pointer font-sans"
            [class.bg-blue-600]="selectedTemplate() === 'postgres'"
            [class.text-white]="selectedTemplate() === 'postgres'"
            [class.border-blue-500]="selectedTemplate() === 'postgres'"
            [class.bg-slate-800]="selectedTemplate() !== 'postgres'"
            [class.text-slate-300]="selectedTemplate() !== 'postgres'"
            [class.border-slate-700]="selectedTemplate() !== 'postgres'">
            Postgres
          </button>
          <button (click)="loadTemplateFile('python')" 
            class="px-2 py-1 text-[10px] rounded border transition-colors cursor-pointer font-sans"
            [class.bg-blue-600]="selectedTemplate() === 'python'"
            [class.text-white]="selectedTemplate() === 'python'"
            [class.border-blue-500]="selectedTemplate() === 'python'"
            [class.bg-slate-800]="selectedTemplate() !== 'python'"
            [class.text-slate-300]="selectedTemplate() !== 'python'"
            [class.border-slate-700]="selectedTemplate() !== 'python'">
            Python
          </button>
        </div>
      </div>

      <!-- Editor Controls Header tabs -->
      <div class="px-4 py-2 bg-slate-900/60 border-b border-slate-800 flex items-center justify-between text-xs">
        <div class="flex gap-2">
          <button (click)="editorSubTab.set('edit')" 
            class="text-slate-300 font-semibold uppercase tracking-wider text-[10px] hover:text-[#2496ed] cursor-pointer flex items-center gap-1 font-sans"
            [class.text-[#2496ed]]="editorSubTab() === 'edit'">
            <mat-icon class="text-xs scale-75">edit</mat-icon>
            Line Editor
          </button>
          <span class="text-slate-700">|</span>
          <button (click)="editorSubTab.set('preview')" 
            class="text-slate-400 font-semibold uppercase tracking-wider text-[10px] hover:text-[#2496ed] cursor-pointer flex items-center gap-1 font-sans"
            [class.text-[#2496ed]]="editorSubTab() === 'preview'">
            <mat-icon class="text-xs scale-75">visibility</mat-icon>
            Aesthetic Syntax
          </button>
        </div>
        <span class="text-[9px] font-mono text-slate-500 uppercase">utf-8</span>
      </div>

      <!-- Editor Content area with JetBrains Mono font context -->
      <div class="flex-grow flex flex-col relative bg-[#040812] min-h-[300px]">
        @if (editorSubTab() === 'edit') {
          <div #monacoContainer class="flex-grow w-full text-left" style="min-height: 300px; font-family: 'JetBrains Mono', monospace;"></div>
        } @else {
          <pre class="flex-grow w-full p-4 overflow-y-auto font-mono text-xs text-left bg-slate-950 text-slate-350 select-text whitespace-pre leading-relaxed border-none rounded-none" 
            [innerHTML]="highlightDockerfile(dockerfile())">
          </pre>
        }
      </div>

      <!-- Linter / Diagnostics Section with High Contrast Contrast visual alerts -->
      <div class="border-t border-slate-800 bg-[#060b14] p-3 shadow-inner">
        <div class="flex justify-between items-center text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2 font-sans select-none">
          <span class="flex items-center gap-1">
            <mat-icon class="text-[12px] text-blue-400">analytics</mat-icon>
            Diagnostics / Recommendations
          </span>
          <span class="bg-[#111e35] text-blue-400 border border-slate-800 px-1.5 py-0.5 rounded text-[8px] uppercase font-semibold">Linter Active</span>
        </div>
        
        <div class="space-y-1.5 max-h-[140px] overflow-y-auto">
          @if (errors().length === 0) {
            <div class="flex items-center gap-2 text-emerald-400 text-xs p-1 select-none">
              <mat-icon class="text-sm">check_circle</mat-icon>
              <span class="text-left font-sans font-medium">Dockerfile matches security best-practices. Ready to build cleanly.</span>
            </div>
          } @else {
            @for (rec of errors(); track rec.line + rec.type) {
              <div class="bg-[#111e34]/70 border border-slate-800/80 rounded-lg p-2.5 text-left transition hover:bg-[#14233c]/85">
                <div class="flex justify-between items-start gap-1">
                  <span class="text-[11px] font-bold text-rose-400 flex items-center gap-1 font-mono">
                    <mat-icon class="text-[14px] h-3.5 w-4.5 text-rose-400">warning</mat-icon>
                    Line {{ rec.line }} [{{ rec.instruction }}]
                  </span>
                  <button (click)="triggerQuickFix(rec)" class="bg-[#1e293b] hover:bg-slate-800 hover:text-white text-slate-100 text-[9px] font-bold px-1.5 py-0.5 rounded border border-slate-700 font-sans cursor-pointer transition flex items-center gap-0.5">
                    <mat-icon class="text-[10px] scale-75">auto_fix_high</mat-icon>
                    Apply Quick-Fix
                  </button>
                </div>
                <p class="text-[10px] text-slate-300 mt-1.5 font-mono mb-1 text-left leading-relaxed">{{ rec.message }}</p>
                <p class="text-[9px] text-slate-400 font-sans italic text-left">Tip: {{ rec.tip }}</p>
              </div>
            }
          }
        </div>
      </div>

      <!-- Action Build Footer -->
      <div class="bg-[#0c1322] p-3 border-t border-slate-800 space-y-2">
        <div class="grid grid-cols-2 gap-2 text-left">
          <div>
            <label for="workspace-image-tag-input-child" class="block text-[9px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-1 select-none">Image Tag</label>
            <input id="workspace-image-tag-input-child" [formControl]="newImageTag()" type="text" placeholder="e.g. custom-app:latest" 
              class="w-full bg-[#050912] border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-slate-700 font-mono">
          </div>
          <div>
            <span class="block text-[9px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-1 select-none font-sans">Build Target</span>
            <div class="text-xs text-slate-300 font-mono py-1.5 leading-relaxed truncate px-1">
              Docker Daemon Socket
            </div>
          </div>
        </div>
        
        <button (click)="executeBuild.emit()" [disabled]="isBuilding()" 
          class="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-550 font-bold text-xs py-2 px-4 rounded-xl border border-transparent cursor-pointer flex items-center justify-center gap-2 transition shadow-md"
          id="workspace-execute-build-btn-child">
          @if (isBuilding()) {
            <span class="w-3.5 h-3.5 border-2 border-slate-400 border-t-white rounded-full animate-spin"></span>
            <span>Compiling Layers...</span>
          } @else {
            <mat-icon class="text-sm">build_circle</mat-icon>
            <span>Execute Docker Build</span>
          }
        </button>
      </div>

    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
  `]
})
export class DockerfileEditor implements AfterViewInit, OnDestroy {
  // Two-way signal bindings
  dockerfile = model<string>('');
  selectedTemplate = model<string>('node');
  
  // Input parameters
  newImageTag = input.required<FormControl<string | null>>();
  isBuilding = input<boolean>(false);
  errors = input<DockerfileDiagnostics[]>([]);

  // Outputs
  loadTemplate = output<string>();
  applyQuickFix = output<DockerfileDiagnostics>();
  executeBuild = output<void>();

  editorSubTab = model<'edit' | 'preview'>('edit');
  
  // Element Ref for Monaco
  monacoContainer = viewChild<ElementRef<HTMLDivElement>>('monacoContainer');

  /* eslint-disable @typescript-eslint/no-explicit-any */
  private monacoEditorInstance: any = null;

  constructor() {
    // Re-sync Monaco editor when dockerfile signal changes from outside
    effect(() => {
      const code = this.dockerfile();
      if (typeof window !== 'undefined' && this.monacoEditorInstance) {
        if (this.monacoEditorInstance.getValue() !== code) {
          this.monacoEditorInstance.setValue(code || '');
        }
      }
    });

    // Re-render markers when errors input signal changes
    effect(() => {
      this.errors();
      this.updateMonacoMarkers();
    });
  }

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

  initMonaco(): void {
    if (typeof window === 'undefined') return;
    const container = this.monacoContainer()?.nativeElement;
    if (!container) return;

    if (this.monacoEditorInstance) {
      const val = this.dockerfile();
      if (this.monacoEditorInstance.getValue() !== val) {
        this.monacoEditorInstance.setValue(val);
      }
      return;
    }

    this.loadMonaco().then((monaco) => {
      const updatedContainer = this.monacoContainer()?.nativeElement;
      if (!updatedContainer) return;

      this.monacoEditorInstance = monaco.editor.create(updatedContainer, {
        value: this.dockerfile(),
        language: 'dockerfile',
        theme: 'vs-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        fontFamily: 'JetBrains Mono, monospace', // Custom monospaced font integration
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
        if (this.dockerfile() !== val) {
          this.dockerfile.set(val);
        }
        this.updateMonacoMarkers();
      });

      this.updateMonacoMarkers();
    }).catch(err => {
      console.error('Error loading monaco editor inside child component', err);
    });
  }

  updateMonacoMarkers(): void {
    if (typeof window !== 'undefined' && this.monacoEditorInstance) {
      const monaco = (window as any).monaco;
      if (monaco) {
        const model = this.monacoEditorInstance.getModel();
        if (model) {
          const errors = this.errors();
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

  loadTemplateFile(template: string): void {
    this.selectedTemplate.set(template);
    this.loadTemplate.emit(template);
  }

  triggerQuickFix(rec: any): void {
    this.applyQuickFix.emit(rec);
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
          cmdClass = isUppercase ? 'text-amber-400 font-bold font-mono' : 'text-amber-450/80 font-bold italic font-mono';
        } else {
          cmdClass = 'text-rose-400 font-bold underline decoration-dotted font-mono';
        }
        
        let escapedArgs = this.escapeHtml(args);
        
        if (escapedArgs.startsWith('[') && escapedArgs.endsWith(']')) {
          escapedArgs = escapedArgs.replace(/"([^"]+)"/g, '<span class="text-emerald-400 font-mono">"$1"</span>');
          escapedArgs = escapedArgs.replace(/'([^']+)'/g, '<span class="text-rose-500 font-bold font-mono">\'$1\'</span>');
        } else {
          escapedArgs = escapedArgs.replace(/(\b\d{2,5}\b)/g, '<span class="text-emerald-400 font-semibold font-mono">$1</span>');
          escapedArgs = escapedArgs.replace(/(\b[A-Za-z0-9_]+)=/g, '<span class="text-blue-400 font-semibold font-mono">$1</span>=');
        }
        
        return `${linePrfx}<span class="${cmdClass}">${cmd}</span> <span class="font-mono text-slate-300">${escapedArgs}</span>`;
      } else {
        const upperCmd = trimmed.toUpperCase();
        const validInstructions = [
          'FROM', 'RUN', 'CMD', 'LABEL', 'MAINTAINER', 'EXPOSE', 'ENV', 
          'ADD', 'COPY', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR', 
          'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL'
        ];
        const cmdClass = validInstructions.includes(upperCmd) ? 'text-amber-400 font-bold font-mono' : 'text-rose-400 font-bold underline decoration-dotted font-mono';
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

  ngAfterViewInit() {
    // Delay slightly to let layout stabilize
    setTimeout(() => {
      this.initMonaco();
    }, 120);

    // Watch for tab switches to initialize/destroy Monaco gracefully
    effect(() => {
      const tab = this.editorSubTab();
      if (tab === 'edit') {
        setTimeout(() => this.initMonaco(), 50);
      } else {
        this.disposeMonaco();
      }
    });
  }

  ngOnDestroy() {
    this.disposeMonaco();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

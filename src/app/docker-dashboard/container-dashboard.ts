import { 
  Component, 
  input, 
  output, 
  computed, 
  signal, 
  ChangeDetectionStrategy 
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { DockerContainer } from './docker-dashboard';

@Component({
  selector: 'app-container-dashboard',
  imports: [CommonModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-5">
      
      <!-- Premium Filter & Controls Header -->
      <div class="bg-[#0b1323]/80 p-4 rounded-xl border border-slate-800/80 flex flex-col sm:flex-row gap-3 items-center justify-between shadow-md">
        
        <!-- Search -->
        <div class="relative w-full sm:w-72">
          <mat-icon class="absolute left-3 top-2.5 text-slate-500 scale-90">search</mat-icon>
          <input type="text" placeholder="Search by name, tag, or ID..." 
            [value]="searchQuery()" 
            (input)="updateSearchQuery($any($event.target).value)"
            class="w-full bg-[#111c30] border border-slate-800 rounded-lg pl-9 pr-4 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 font-sans transition">
        </div>

        <!-- Filter & Sort Actions -->
        <div class="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
          <!-- Status Filter -->
          <div class="flex items-center bg-slate-950/40 rounded-lg p-1 border border-slate-850/80">
            <button (click)="statusFilter.set('all')" 
              [class.bg-blue-600]="statusFilter() === 'all'"
              [class.text-white]="statusFilter() === 'all'"
              class="px-3 py-1 text-[10px] font-bold rounded cursor-pointer transition text-slate-400 hover:text-slate-200">
              All
            </button>
            <button (click)="statusFilter.set('running')" 
              [class.bg-blue-600]="statusFilter() === 'running'"
              [class.text-white]="statusFilter() === 'running'"
              class="px-3 py-1 text-[10px] font-bold rounded cursor-pointer transition text-slate-400 hover:text-slate-200">
              Running
            </button>
            <button (click)="statusFilter.set('stopped')" 
              [class.bg-blue-600]="statusFilter() === 'stopped'"
              [class.text-white]="statusFilter() === 'stopped'"
              class="px-3 py-1 text-[10px] font-bold rounded cursor-pointer transition text-slate-400 hover:text-slate-200">
              Stopped
            </button>
          </div>

          <!-- Sort Order -->
          <div class="flex items-center gap-1.5 text-xs text-slate-400 font-sans">
            <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Sort:</span>
            <select [value]="sortOrder()" (change)="updateSortOrder($any($event.target).value)" 
              class="bg-[#111c30] border border-slate-800 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500 font-sans">
              <option value="name">Name</option>
              <option value="cpu">CPU Usage</option>
              <option value="memory">Memory Usage</option>
            </select>
          </div>
        </div>

      </div>

      <!-- Containers Grid Layout -->
      @if (filteredContainers().length === 0) {
        <div class="bg-slate-900/40 border border-slate-800/80 p-12 rounded-2xl text-center flex flex-col items-center justify-center gap-2">
          <mat-icon class="text-4xl text-slate-600">layers_clear</mat-icon>
          <h4 class="text-sm font-semibold text-slate-300">No Containers Found</h4>
          <p class="text-xs text-slate-500 max-w-sm mx-auto">Try adjusting your filters or deploy a new container node under the "Workspace" or "Images" tab.</p>
        </div>
      } @else {
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          @for (c of filteredContainers(); track c.id) {
            <div class="bg-[#0b1323] border rounded-2xl p-4.5 shadow-md transition hover:border-slate-700/80 hover:shadow-lg flex flex-col justify-between min-h-[310px]"
              [class.border-slate-800/90]="c.status !== 'running'"
              [class.border-emerald-500/15]="c.status === 'running'">
              
              <!-- Card Top Header -->
              <div class="space-y-1.5">
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2 overflow-hidden">
                    <!-- Status Pulsing indicator -->
                    <span class="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      [class.bg-emerald-500]="c.status === 'running'"
                      [class.bg-rose-500]="c.status === 'stopped'"
                      [class.animate-pulse]="c.status === 'running'">
                    </span>
                    <h4 class="font-bold text-white text-sm truncate" [title]="c.name">
                      {{ c.name }}
                    </h4>
                  </div>
                  <!-- Mini Status Badge -->
                  <span class="px-2 py-0.5 rounded text-[9px] uppercase tracking-wider font-extrabold"
                    [class.bg-emerald-950]="c.status === 'running'"
                    [class.text-emerald-400]="c.status === 'running'"
                    [class.border]="c.status === 'running'"
                    [class.border-emerald-800/30]="c.status === 'running'"
                    [class.bg-slate-900]="c.status !== 'running'"
                    [class.text-slate-400]="c.status !== 'running'">
                    {{ c.status }}
                  </span>
                </div>

                <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-400 font-mono">
                  <span class="bg-slate-950 px-1.5 py-0.5 rounded text-slate-500">ID: {{ c.id.substring(0, 8) }}</span>
                  <span class="text-blue-400 select-all">{{ c.imageTag }}</span>
                </div>
              </div>

              <!-- Metrics Visual Dials Section -->
              <div class="my-4 py-3 border-y border-slate-850/60 grid grid-cols-2 gap-3">
                <!-- CPU Metric Dial -->
                <div class="bg-[#050912]/80 p-2.5 rounded-xl border border-slate-900 flex flex-col justify-between">
                  <div class="flex items-center justify-between text-[9px] font-bold text-slate-500 tracking-wider">
                    <span class="flex items-center gap-1">
                      <mat-icon class="text-[11px] h-3 w-3 text-red-400">speed</mat-icon>
                      CPU
                    </span>
                    <span class="font-mono text-white">{{ c.stats?.cpu?.toFixed(1) || '0.0' }}%</span>
                  </div>
                  <!-- CPU bar -->
                  <div class="h-1.5 w-full bg-slate-900 rounded-full mt-2 overflow-hidden">
                    <div class="h-full rounded-full transition-all duration-300"
                      [style.width.%]="Math.min(100, (c.stats?.cpu || 0) * 8)"
                      [class.bg-emerald-500]="(c.stats?.cpu || 0) < 5"
                      [class.bg-amber-500]="(c.stats?.cpu || 0) >= 5 && (c.stats?.cpu || 0) < 12"
                      [class.bg-rose-500]="(c.stats?.cpu || 0) >= 12">
                    </div>
                  </div>
                </div>

                <!-- Memory Metric Dial -->
                <div class="bg-[#050912]/80 p-2.5 rounded-xl border border-slate-900 flex flex-col justify-between">
                  <div class="flex items-center justify-between text-[9px] font-bold text-slate-500 tracking-wider">
                    <span class="flex items-center gap-1">
                      <mat-icon class="text-[11px] h-3 w-3 text-blue-400">memory</mat-icon>
                      MEMORY
                    </span>
                    <span class="font-mono text-white">{{ c.stats?.memory?.toFixed(1) || '0.0' }}M</span>
                  </div>
                  <!-- Memory bar -->
                  <div class="h-1.5 w-full bg-slate-900 rounded-full mt-2 overflow-hidden">
                    <div class="h-full rounded-full transition-all duration-300"
                      [style.width.%]="Math.min(100, ((c.stats?.memory || 0) / (c.stats?.memoryLimit || 512)) * 100)"
                      [class.bg-emerald-500]="((c.stats?.memory || 0) / (c.stats?.memoryLimit || 512)) < 0.4"
                      [class.bg-amber-500]="((c.stats?.memory || 0) / (c.stats?.memoryLimit || 512)) >= 0.4 && ((c.stats?.memory || 0) / (c.stats?.memoryLimit || 512)) < 0.7"
                      [class.bg-rose-500]="((c.stats?.memory || 0) / (c.stats?.memoryLimit || 512)) >= 0.7">
                    </div>
                  </div>
                </div>

                <!-- Network IO details -->
                <div class="col-span-2 bg-[#050912]/40 p-2 rounded-lg border border-slate-900 flex justify-between items-center text-[10px] font-mono text-slate-400">
                  <div class="flex items-center gap-1.5">
                    <mat-icon class="text-xs text-slate-500">settings_ethernet</mat-icon>
                    <span>IP: {{ c.ipAddress || '0.0.0.0' }}</span>
                  </div>
                  <div class="flex items-center gap-3">
                    <span class="flex items-center gap-0.5 text-emerald-500">
                      <mat-icon class="text-[10px] h-3 w-3">arrow_downward</mat-icon>
                      {{ c.stats?.netIn?.toFixed(1) || '0.0' }}K
                    </span>
                    <span class="flex items-center gap-0.5 text-blue-500">
                      <mat-icon class="text-[10px] h-3 w-3">arrow_upward</mat-icon>
                      {{ c.stats?.netOut?.toFixed(1) || '0.0' }}K
                    </span>
                  </div>
                </div>
              </div>

              <!-- Meta specs footer details -->
              <div class="text-[10px] text-slate-500 font-sans flex items-center justify-between mb-3 px-1">
                <span class="flex items-center gap-1">
                  <mat-icon class="text-xs">share</mat-icon>
                  Port: 
                  @if (hasPorts(c)) {
                    @for (hostPort of getHostPorts(c); track hostPort) {
                      <strong class="text-blue-400">{{ hostPort }} → {{ c.ports[hostPort] }}</strong>
                    }
                  } @else {
                    <span class="italic">none</span>
                  }
                </span>
                <span class="flex items-center gap-1">
                  <mat-icon class="text-xs">dns</mat-icon>
                  Net: <strong class="text-slate-300 uppercase">{{ c.network }}</strong>
                </span>
              </div>

              <!-- Interactive Controls Area -->
              <div class="grid grid-cols-3 gap-1.5 border-t border-slate-850/50 pt-3">
                <!-- Action 1: Toggle State (Stop/Start) -->
                <button (click)="toggleStatus.emit(c.id)" 
                  class="flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border transition duration-150 cursor-pointer"
                  [class.bg-amber-600/10]="c.status === 'running'"
                  [class.text-amber-400]="c.status === 'running'"
                  [class.border-amber-500/20]="c.status === 'running'"
                  [class.hover:bg-amber-500/20]="c.status === 'running'"
                  [class.bg-emerald-600/10]="c.status !== 'running'"
                  [class.text-emerald-400]="c.status !== 'running'"
                  [class.border-emerald-500/20]="c.status !== 'running'"
                  [class.hover:bg-emerald-500/20]="c.status !== 'running'">
                  <mat-icon class="text-xs scale-90">{{ c.status === 'running' ? 'pause_circle' : 'play_circle' }}</mat-icon>
                  <span>{{ c.status === 'running' ? 'Stop' : 'Start' }}</span>
                </button>

                <!-- Action 2: Restart -->
                <button (click)="restart.emit(c.id)" [disabled]="c.status !== 'running'"
                  class="flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border bg-blue-600/10 text-blue-400 border-blue-500/20 hover:bg-blue-500/20 disabled:opacity-40 disabled:hover:bg-transparent transition duration-150 cursor-pointer">
                  <mat-icon class="text-xs scale-90">replay</mat-icon>
                  <span>Restart</span>
                </button>

                <!-- Action 3: Delete/Terminate -->
                <button (click)="purge.emit(c.id)" 
                  class="flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border bg-rose-600/10 text-rose-400 border-rose-500/20 hover:bg-rose-500/20 transition duration-150 cursor-pointer">
                  <mat-icon class="text-xs scale-90">delete_outline</mat-icon>
                  <span>Purge</span>
                </button>

                <!-- Panel utilities for running node -->
                @if (c.status === 'running') {
                  <!-- Terminal CLI -->
                  <button (click)="terminal.emit(c)"
                    class="col-span-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[10px] font-semibold border bg-slate-800/60 text-slate-200 border-slate-700/60 hover:bg-slate-750 transition duration-150 cursor-pointer">
                    <mat-icon class="text-xs scale-90">terminal</mat-icon>
                    <span>Terminal</span>
                  </button>

                  <!-- Stream Logs -->
                  <button (click)="logs.emit(c)"
                    class="col-span-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[10px] font-semibold border bg-slate-800/60 text-slate-200 border-slate-700/60 hover:bg-slate-750 transition duration-150 cursor-pointer">
                    <mat-icon class="text-xs scale-90">list_alt</mat-icon>
                    <span>Logs</span>
                  </button>

                  <!-- Virtual Browser Integration (if web mapped) -->
                  @if (hasPorts(c)) {
                    <button (click)="triggerBrowser(c)"
                      class="col-span-1 flex items-center justify-center gap-1 py-1.5 px-2 rounded-lg text-[10px] font-bold border bg-sky-600/10 text-sky-400 border-sky-500/20 hover:bg-sky-500/20 transition duration-150 cursor-pointer">
                      <mat-icon class="text-xs scale-90">language</mat-icon>
                      <span>Browser</span>
                    </button>
                  } @else {
                    <div class="col-span-1 bg-slate-900/30 border border-slate-900 text-slate-600 text-[10px] rounded-lg flex items-center justify-center gap-1 select-none">
                      <mat-icon class="text-xs scale-90 text-slate-700">link_off</mat-icon>
                      <span>No Port</span>
                    </div>
                  }
                } @else {
                  <div class="col-span-3 bg-slate-900/60 p-2 rounded-lg border border-slate-950 text-center select-none text-[10px] text-slate-500 italic flex items-center justify-center gap-1.5">
                    <mat-icon class="text-xs text-slate-600">info_outline</mat-icon>
                    <span>Instance offline. Launch layer to stream statistics & mount ports.</span>
                  </div>
                }
              </div>

            </div>
          }
        </div>
      }

    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
  `]
})
export class ContainerDashboard {
  // Container inputs
  containers = input.required<DockerContainer[]>();

  // Interactive hooks
  toggleStatus = output<string>();
  restart = output<string>();
  purge = output<string>();
  terminal = output<DockerContainer>();
  logs = output<DockerContainer>();
  browser = output<{ container: DockerContainer; port: number }>();

  // local filter states
  searchQuery = signal<string>('');
  statusFilter = signal<'all' | 'running' | 'stopped'>('all');
  sortOrder = signal<'name' | 'cpu' | 'memory'>('name');

  // Math references for template usage
  Math = Math;

  // Filtered lists computed automatically
  filteredContainers = computed(() => {
    let list = this.containers();
    const query = this.searchQuery().toLowerCase().trim();
    
    if (query) {
      list = list.filter(c => 
        c.name.toLowerCase().includes(query) || 
        c.imageTag.toLowerCase().includes(query) || 
        c.id.toLowerCase().includes(query)
      );
    }

    const filter = this.statusFilter();
    if (filter !== 'all') {
      list = list.filter(c => c.status === filter);
    }

    const sort = this.sortOrder();
    return [...list].sort((a, b) => {
      if (sort === 'cpu') {
        const cpuA = a.status === 'running' ? (a.stats?.cpu || 0) : -1;
        const cpuB = b.status === 'running' ? (b.stats?.cpu || 0) : -1;
        return cpuB - cpuA;
      }
      if (sort === 'memory') {
        const memA = a.status === 'running' ? (a.stats?.memory || 0) : -1;
        const memB = b.status === 'running' ? (b.stats?.memory || 0) : -1;
        return memB - memA;
      }
      return a.name.localeCompare(b.name);
    });
  });

  updateSearchQuery(val: string): void {
    this.searchQuery.set(val);
  }

  updateSortOrder(val: 'name' | 'cpu' | 'memory'): void {
    this.sortOrder.set(val);
  }

  hasPorts(c: DockerContainer): boolean {
    return c.ports && Object.keys(c.ports).length > 0;
  }

  getHostPorts(c: DockerContainer): number[] {
    if (!c.ports) return [];
    return Object.keys(c.ports).map(p => parseInt(p, 10));
  }

  triggerBrowser(c: DockerContainer): void {
    const ports = this.getHostPorts(c);
    if (ports.length > 0) {
      this.browser.emit({ container: c, port: ports[0] });
    }
  }
}

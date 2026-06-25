import { 
  Component, 
  input, 
  output, 
  signal, 
  ElementRef, 
  viewChild, 
  AfterViewInit, 
  OnDestroy, 
  effect,
  ChangeDetectionStrategy
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatIconModule } from '@angular/material/icon';
import { DockerNetwork, DockerContainer } from './docker-dashboard';
import * as d3 from 'd3';

export interface VisualizerNode extends d3.SimulationNodeDatum {
  id: string;
  containerId?: string;
  name: string;
  type: 'gateway' | 'network' | 'container';
  ip?: string;
  subnet?: string;
  gateway?: string;
  driver?: string;
  status?: string;
  imageTag?: string;
  network?: string;
  isDragging?: boolean;
}

export interface VisualizerLink extends d3.SimulationLinkDatum<VisualizerNode> {
  id: string;
  source: string | VisualizerNode;
  target: string | VisualizerNode;
  type: 'trunk' | 'bridge';
  active?: boolean;
}

@Component({
  selector: 'app-network-visualizer',
  imports: [CommonModule, MatIconModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="relative w-full h-[520px] bg-[#040812] border border-slate-800 rounded-2xl overflow-hidden shadow-inner flex flex-col lg:flex-row" id="network-visualizer-container">
      
      <!-- Canvas Area -->
      <div class="flex-grow h-full relative" #canvasContainer>
        
        <!-- Legend Overlay -->
        <div class="absolute top-4 left-4 bg-[#080f1a]/90 backdrop-blur-md border border-slate-800/80 p-3 rounded-xl space-y-1.5 z-10 text-left select-none max-w-xs shadow-md">
          <span class="text-[9px] font-bold text-slate-550 uppercase tracking-widest block mb-1">Topology Legend</span>
          <div class="flex items-center gap-2 text-[10px] text-slate-300">
            <span class="w-2.5 h-2.5 rounded-full bg-slate-700 border border-slate-500 flex-shrink-0"></span>
            <span>Localhost Gateway WAN</span>
          </div>
          <div class="flex items-center gap-2 text-[10px] text-slate-300">
            <span class="w-2.5 h-2.5 rounded-full bg-purple-600/30 border border-purple-500 flex-shrink-0"></span>
            <span>Virtual Subnet Router</span>
          </div>
          <div class="flex items-center gap-2 text-[10px] text-slate-300">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-600/30 border border-emerald-450 flex-shrink-0 animate-pulse"></span>
            <span>Active Container (Online)</span>
          </div>
          <div class="flex items-center gap-2 text-[10px] text-slate-300">
            <span class="w-2.5 h-2.5 rounded-full bg-slate-900 border border-slate-800 flex-shrink-0"></span>
            <span>Offline Container (Offline)</span>
          </div>
          <p class="text-[9px] text-slate-500 italic mt-1 pt-1.5 border-t border-slate-850">
            💡 Drag a container puck onto a network router to reconnect instantly!
          </p>
        </div>

        <!-- D3 SVG Map Graph -->
        <svg #svgElement class="w-full h-full block">
          <!-- Background Grid Matrix patterns -->
          <defs>
            <pattern id="network-dot-grid" width="20" height="20" patternUnits="userSpaceOnUse">
              <circle cx="2" cy="2" r="1" fill="#334155" fill-opacity="0.25" />
            </pattern>
            <radialGradient id="gateway-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.15" />
              <stop offset="100%" stop-color="#38bdf8" stop-opacity="0" />
            </radialGradient>
            <radialGradient id="network-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#a855f7" stop-opacity="0.18" />
              <stop offset="100%" stop-color="#a855f7" stop-opacity="0" />
            </radialGradient>
            <radialGradient id="container-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stop-color="#34d399" stop-opacity="0.15" />
              <stop offset="100%" stop-color="#34d399" stop-opacity="0" />
            </radialGradient>
          </defs>
          
          <rect width="100%" height="100%" fill="url(#network-dot-grid)" />
          
          <!-- D3 Group Layers -->
          <g class="links-layer"></g>
          <g class="nodes-layer"></g>
        </svg>

        <!-- No data status -->
        @if (containers().length === 0 && networks().length === 0) {
          <div class="absolute inset-0 flex flex-col items-center justify-center bg-[#040812]/95 backdrop-blur-sm p-6 text-center">
            <mat-icon class="text-4xl text-slate-700 animate-bounce">device_hub</mat-icon>
            <h4 class="text-sm font-semibold text-slate-300 mt-2">No Active Bridges Configured</h4>
            <p class="text-xs text-slate-500 max-w-xs mt-1">Boot up container endpoints first to stream real-time D3 topology graphs!</p>
          </div>
        }
      </div>

      <!-- Node Inspector Panel -->
      <div class="w-full lg:w-72 bg-[#080f1a] border-t lg:border-t-0 lg:border-l border-slate-800 p-4 flex flex-col justify-between text-xs select-none relative z-20">
        
        <!-- Header -->
        <div class="space-y-4">
          <div class="flex items-center gap-2 border-b border-slate-800 pb-2.5">
            <mat-icon class="text-purple-400">insights</mat-icon>
            <div class="text-left">
              <h4 class="text-xs font-bold text-slate-200">Bridge Inspector</h4>
              <p class="text-[9px] text-slate-500 uppercase tracking-wider font-semibold">Real-time Node Metadata</p>
            </div>
          </div>

          <!-- Dynamic Node Info Details -->
          <div class="space-y-3.5 text-left">
            @if (selectedNode()) {
              @let node = selectedNode()!;
              
              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider"
                    [class.bg-sky-500/10]="node.type === 'gateway'"
                    [class.text-sky-400]="node.type === 'gateway'"
                    [class.bg-purple-500/10]="node.type === 'network'"
                    [class.text-purple-400]="node.type === 'network'"
                    [class.bg-emerald-500/10]="node.type === 'container'"
                    [class.text-emerald-400]="node.type === 'container'">
                    {{ node.type }}
                  </span>
                  <span class="text-[10px] text-slate-500 font-mono">ID: {{ node.id }}</span>
                </div>
                
                <h3 class="text-sm font-extrabold text-white leading-snug break-all">{{ node.name }}</h3>
              </div>

              <!-- Gateway Details -->
              @if (node.type === 'gateway') {
                <div class="bg-slate-900/40 border border-slate-850 p-3 rounded-xl space-y-2">
                  <div class="flex justify-between">
                    <span class="text-slate-500 text-[10px]">Interface Loopback:</span>
                    <strong class="text-slate-300 font-mono">lo:0</strong>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-slate-500 text-[10px]">Primary IPv4:</span>
                    <strong class="text-slate-300 font-mono">{{ node.ip }}</strong>
                  </div>
                  <div class="flex justify-between">
                    <span class="text-slate-500 text-[10px]">WAN Access:</span>
                    <strong class="text-emerald-400 font-mono">Bridge NAT Enabled</strong>
                  </div>
                </div>
              }

              <!-- Subnet Router Details -->
              @if (node.type === 'network') {
                <div class="bg-[#0c1322]/80 border border-slate-800/80 p-3 rounded-xl space-y-2.5">
                  <div class="flex justify-between border-b border-slate-900/40 pb-1.5">
                    <span class="text-slate-500 text-[10px]">Virtual Subnet:</span>
                    <strong class="text-purple-300 font-mono">{{ node.subnet || 'unassigned' }}</strong>
                  </div>
                  <div class="flex justify-between border-b border-slate-900/40 pb-1.5">
                    <span class="text-slate-500 text-[10px]">Gateway Router:</span>
                    <strong class="text-purple-300 font-mono">{{ node.gateway || 'unassigned' }}</strong>
                  </div>
                  <div class="flex justify-between border-b border-slate-900/40 pb-1.5">
                    <span class="text-slate-500 text-[10px]">Driver Mode:</span>
                    <strong class="text-slate-300 font-mono uppercase">{{ node.driver }}</strong>
                  </div>
                  <div class="pt-1.5">
                    <span class="text-slate-500 text-[9px] font-bold block uppercase mb-1">Attached Node Count:</span>
                    <div class="text-[10px] text-slate-300 font-mono bg-slate-950 px-2 py-1.5 rounded-lg border border-slate-900 leading-normal">
                      {{ getContainersInNetwork(node.name).length }} endpoints bridged
                    </div>
                  </div>
                </div>
              }

              <!-- Container Node Details -->
              @if (node.type === 'container') {
                <div class="bg-[#0c1322]/80 border border-slate-800/80 p-3 rounded-xl space-y-2.5">
                  <div class="flex justify-between border-b border-slate-900/40 pb-1.5">
                    <span class="text-slate-500 text-[10px]">Local IP Address:</span>
                    <strong class="text-emerald-400 font-mono">{{ node.ip }}</strong>
                  </div>
                  <div class="flex justify-between border-b border-slate-900/40 pb-1.5">
                    <span class="text-slate-500 text-[10px]">Status:</span>
                    <strong [class.text-emerald-400]="node.status === 'running'"
                            [class.text-rose-400]="node.status !== 'running'"
                            class="font-mono uppercase">{{ node.status }}</strong>
                  </div>
                  <div class="flex justify-between border-b border-slate-900/40 pb-1.5">
                    <span class="text-slate-500 text-[10px]">Parent Bridge:</span>
                    <strong class="text-purple-300 font-mono">{{ node.network }}</strong>
                  </div>
                  <div class="text-[10px] space-y-1 pt-1">
                    <span class="text-slate-500 text-[9px] font-bold block uppercase leading-none">Mapped Image:</span>
                    <div class="text-blue-400 truncate font-mono select-all text-[11px] leading-tight" [title]="node.imageTag">
                      {{ node.imageTag }}
                    </div>
                  </div>
                </div>
              }

              <button (click)="selectedNode.set(null)" class="w-full bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg py-1.5 px-3 text-[10px] text-slate-400 hover:text-white font-bold cursor-pointer transition flex items-center justify-center gap-1">
                <mat-icon class="text-xs scale-90">clear</mat-icon>
                <span>Clear Inspector</span>
              </button>

            } @else {
              <!-- Standard State Overview -->
              <div class="space-y-3.5">
                <p class="text-slate-400 text-[11px] leading-relaxed">
                  Click on any node in the SVG graph mapping to inspect physical routing variables, assigned virtual subnet drivers, or endpoint allocations.
                </p>

                <div class="p-3 bg-slate-900/30 border border-slate-850 rounded-xl space-y-2.5 font-mono">
                  <span class="text-[9px] font-bold text-slate-500 uppercase tracking-widest block">Topology Overview</span>
                  <div class="flex justify-between text-[11px]">
                    <span class="text-slate-500">Virtual Subnets:</span>
                    <strong class="text-white">{{ networks().length }}</strong>
                  </div>
                  <div class="flex justify-between text-[11px]">
                    <span class="text-slate-500">Active Nodes:</span>
                    <strong class="text-emerald-400">{{ getRunningContainersCount() }}</strong>
                  </div>
                  <div class="flex justify-between text-[11px]">
                    <span class="text-slate-500">Total Containers:</span>
                    <strong class="text-white">{{ containers().length }}</strong>
                  </div>
                </div>
                
                <div class="bg-purple-950/10 border border-purple-900/20 p-3 rounded-xl text-left select-none">
                  <span class="text-[9px] text-purple-400 font-extrabold uppercase block tracking-wider mb-1">Interactive Snapping</span>
                  <p class="text-[10px] text-slate-400 leading-normal">
                    You can drag running container nodes close to any subnet router, then release to hot-plug them dynamically onto that subnet structure.
                  </p>
                </div>
              </div>
            }
          </div>
        </div>

        <!-- System Stats footer -->
        <div class="border-t border-slate-800 pt-3 text-[10px] font-mono text-slate-500 text-left flex justify-between items-center select-none">
          <span>Engine: Docker-Socket</span>
          <span class="text-[9px] bg-slate-900 text-emerald-400 border border-emerald-950 px-1.5 py-px rounded font-bold">100% ONLINE</span>
        </div>

      </div>

    </div>
  `,
  styles: [`
    :host {
      display: block;
    }
  `]
})
export class NetworkVisualizer implements AfterViewInit, OnDestroy {
  // Reactive Signal Inputs
  networks = input.required<DockerNetwork[]>();
  containers = input.required<DockerContainer[]>();

  // Interactive Reconnect trigger hook
  moveContainer = output<{ containerId: string; networkName: string }>();

  // Element handles
  canvasContainer = viewChild<ElementRef<HTMLDivElement>>('canvasContainer');
  svgElement = viewChild<ElementRef<SVGElement>>('svgElement');

  // Node Inspector selection state
  selectedNode = signal<VisualizerNode | null>(null);

  // ResizeObserver reference
  private resizeObserver: ResizeObserver | null = null;
  
  // D3 force simulation references
  private simulation: d3.Simulation<VisualizerNode, VisualizerLink> | null = null;
  private width = 600;
  private height = 320;

  // Track coordinates of nodes across updates to preserve locations and prevent sudden visual popping/jumping
  private nodePositionCache = new Map<string, { x: number; y: number; fx: number | null; fy: number | null }>();

  constructor() {
    // Re-render and update D3 simulation graph when input models change
    effect(() => {
      const nets = this.networks();
      const conts = this.containers();
      this.updateGraph(nets, conts);
    });
  }

  ngAfterViewInit() {
    if (typeof window !== 'undefined') {
      const container = this.canvasContainer()?.nativeElement;
      if (container) {
        this.resizeObserver = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const rect = entry.contentRect;
            this.width = rect.width || 600;
            this.height = rect.height || 420;
            this.handleResize();
          }
        });
        this.resizeObserver.observe(container);

        // Run initial configuration
        const rect = container.getBoundingClientRect();
        this.width = rect.width || 600;
        this.height = rect.height || 420;
      }
    }
    
    // Build the initial chart
    this.updateGraph(this.networks(), this.containers());
  }

  private handleResize() {
    if (this.simulation) {
      this.simulation.force('center', d3.forceCenter(this.width / 2, this.height / 2 + 10));
      this.simulation.alpha(0.3).restart();
    }
    const svg = this.svgElement()?.nativeElement;
    if (svg) {
      svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
    }
  }

  getRunningContainersCount(): number {
    return this.containers().filter(c => c.status === 'running').length;
  }

  getContainersInNetwork(netName: string): DockerContainer[] {
    return this.containers().filter(c => c.network === netName);
  }

  private updateGraph(nets: DockerNetwork[], conts: DockerContainer[]) {
    const svgEl = this.svgElement()?.nativeElement;
    if (!svgEl) return;

    // Cache current node coordinates to maintain structural consistency on data re-load
    if (this.simulation) {
      this.simulation.nodes().forEach(node => {
        if (node.x !== undefined && node.y !== undefined) {
          this.nodePositionCache.set(node.id, {
            x: node.x,
            y: node.y,
            fx: node.fx || null,
            fy: node.fy || null
          });
        }
      });
    }

    // 1. Construct Nodes structure
    const nodes: VisualizerNode[] = [];
    
    // Localhost WAN Gateway node (Pinned near top center)
    const gatewayNodeId = 'gateway_wan';
    const gatewayCached = this.nodePositionCache.get(gatewayNodeId);
    nodes.push({
      id: gatewayNodeId,
      name: 'LOCALHOST GATEWAY WAN',
      type: 'gateway',
      ip: '127.0.0.1',
      x: gatewayCached?.x ?? this.width / 2,
      y: gatewayCached?.y ?? 45,
      fx: this.width / 2, // Anchor gateway at center-top
      fy: 45
    });

    // Subnet Network Switch Nodes
    nets.forEach((net, index) => {
      const netId = `net_${net.name}`;
      const cached = this.nodePositionCache.get(netId);
      
      // Calculate balanced starting placement
      const spacing = nets.length > 1 ? (this.width - 160) / (nets.length - 1) : 0;
      const defaultX = nets.length > 1 ? 80 + (index * spacing) : this.width / 2;
      const defaultY = this.height / 2;

      nodes.push({
        id: netId,
        name: net.name,
        type: 'network',
        subnet: net.subnet,
        gateway: net.gateway,
        driver: net.driver,
        x: cached?.x ?? defaultX,
        y: cached?.y ?? defaultY,
        fx: cached?.fx ?? null,
        fy: cached?.fy ?? null
      });
    });

    // Container Nodes
    conts.forEach(c => {
      const contNodeId = `container_${c.id}`;
      const cached = this.nodePositionCache.get(contNodeId);
      
      // Find starting pos near its connected network router node
      const parentNet = nets.find(n => n.name === c.network);
      let defaultX = this.width / 2;
      let defaultY = this.height - 80;
      
      if (parentNet) {
        const netNodeIndex = nets.findIndex(n => n.name === c.network);
        const spacing = nets.length > 1 ? (this.width - 160) / (nets.length - 1) : 0;
        defaultX = (nets.length > 1 ? 80 + (netNodeIndex * spacing) : this.width / 2) + (Math.random() * 40 - 20);
        defaultY = this.height / 2 + 80 + (Math.random() * 30 - 15);
      }

      nodes.push({
        id: contNodeId,
        containerId: c.id,
        name: c.name,
        type: 'container',
        ip: c.ipAddress,
        status: c.status,
        imageTag: c.imageTag,
        network: c.network,
        x: cached?.x ?? defaultX,
        y: cached?.y ?? defaultY,
        fx: cached?.fx ?? null,
        fy: cached?.fy ?? null
      });
    });

    // 2. Construct Link vectors
    const links: VisualizerLink[] = [];
    
    // Trunk line links from WAN Gateway to Subnet Routers
    nets.forEach(net => {
      links.push({
        id: `trunk_link_${net.name}`,
        source: gatewayNodeId,
        target: `net_${net.name}`,
        type: 'trunk',
        active: true
      });
    });

    // Bridge lines from containers to subnets
    conts.forEach(c => {
      links.push({
        id: `bridge_link_${c.id}`,
        source: `container_${c.id}`,
        target: `net_${c.network}`,
        type: 'bridge',
        active: c.status === 'running'
      });
    });

    // Re-verify current inspector selection matches existing or newly updated nodes
    const activeSelection = this.selectedNode();
    if (activeSelection) {
      const updatedMatch = nodes.find(n => n.id === activeSelection.id);
      if (updatedMatch) {
        this.selectedNode.set(updatedMatch);
      } else {
        this.selectedNode.set(null);
      }
    }

    // 3. Initiate or adjust D3 Force Simulation Engine
    const svg = d3.select(svgEl);
    
    if (this.simulation) {
      this.simulation.stop();
    }

    this.simulation = d3.forceSimulation<VisualizerNode, VisualizerLink>(nodes)
      .force('link', d3.forceLink<VisualizerNode, VisualizerLink>(links)
        .id(d => d.id)
        .distance(d => d.type === 'trunk' ? 120 : 70)
        .strength(1.1)
      )
      .force('charge', d3.forceManyBody().strength(-240))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2 + 10))
      .force('collision', d3.forceCollide<VisualizerNode>().radius(d => {
        if (d.type === 'gateway') return 38;
        if (d.type === 'network') return 48;
        return 32;
      }).iterations(2))
      .velocityDecay(0.35);

    // 4. Render Layout structures (Nodes and Links)
    const linksGroup = svg.select('.links-layer');
    const nodesGroup = svg.select('.nodes-layer');

    // Draw Links
    const linkSel = linksGroup.selectAll<SVGLineElement, VisualizerLink>('.network-link')
      .data(links, d => d.id);

    // Remove defunct links
    linkSel.exit().remove();

    // Create new links
    const linkEnter = linkSel.enter().append('line')
      .attr('class', 'network-link')
      .attr('stroke', d => d.type === 'trunk' ? '#475569' : '#a855f7')
      .attr('stroke-width', d => d.type === 'trunk' ? 1.5 : 2.0)
      .attr('stroke-opacity', d => d.active ? 0.75 : 0.2)
      .attr('stroke-dasharray', d => d.type === 'trunk' ? '4,4' : d.active ? 'none' : '2,3');

    // Merge existing & new
    const linkCombined = linkEnter.merge(linkSel);

    // Draw Nodes
    const nodeSel = nodesGroup.selectAll<SVGGElement, VisualizerNode>('.network-node')
      .data(nodes, d => d.id);

    // Remove defunct nodes
    nodeSel.exit().remove();

    // Create new nodes Group
    const nodeEnter = nodeSel.enter().append('g')
      .attr('class', 'network-node')
      .style('cursor', 'grab')
      .on('click', (event, d) => {
        // Prevent click trigger when ending a drag operation
        if (event.defaultPrevented) return;
        this.selectedNode.set(d);
      });

    // Node Visual background circle representing glow
    nodeEnter.append('circle')
      .attr('class', 'glow-ring')
      .attr('r', d => d.type === 'gateway' ? 24 : d.type === 'network' ? 32 : 20)
      .attr('fill', d => d.type === 'gateway' ? 'url(#gateway-glow)' : d.type === 'network' ? 'url(#network-glow)' : 'url(#container-glow)')
      .style('pointer-events', 'none');

    // Node Core Solid shape circle
    nodeEnter.append('circle')
      .attr('class', 'core-node')
      .attr('r', d => d.type === 'gateway' ? 16 : d.type === 'network' ? 22 : 14)
      .attr('fill', d => {
        if (d.type === 'gateway') return '#0f172a';
        if (d.type === 'network') return '#111827';
        return d.status === 'running' ? '#1e1b4b' : '#0a0f1d';
      })
      .attr('stroke', d => {
        if (d.type === 'gateway') return '#0284c7';
        if (d.type === 'network') return '#c084fc';
        return d.status === 'running' ? '#10b981' : '#475569';
      })
      .attr('stroke-width', d => d.type === 'gateway' ? 2.5 : d.type === 'network' ? 3.0 : 1.5);

    // Inner Core Pulsar dot for active networks/containers
    nodeEnter.filter(d => d.type === 'container' && d.status === 'running')
      .append('circle')
      .attr('class', 'active-pulsar')
      .attr('r', 4.5)
      .attr('fill', '#10b981')
      .style('pointer-events', 'none');

    // Icon representations inside nodes
    nodeEnter.append('text')
      .attr('class', 'node-icon material-icons')
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .attr('font-size', d => d.type === 'gateway' ? '14px' : d.type === 'network' ? '15px' : '11px')
      .attr('fill', d => {
        if (d.type === 'gateway') return '#38bdf8';
        if (d.type === 'network') return '#d8b4fe';
        return d.status === 'running' ? '#6ee7b7' : '#64748b';
      })
      .text(d => {
        if (d.type === 'gateway') return 'cloud';
        if (d.type === 'network') return 'lan';
        return 'dns';
      })
      .style('pointer-events', 'none')
      .style('user-select', 'none');

    // Display Text Labels
    nodeEnter.append('text')
      .attr('class', 'node-label')
      .attr('text-anchor', 'middle')
      .attr('y', d => d.type === 'gateway' ? -26 : d.type === 'network' ? 38 : 28)
      .attr('fill', '#f1f5f9')
      .attr('font-size', '9.5px')
      .attr('font-weight', 'bold')
      .style('user-select', 'none')
      .style('pointer-events', 'none')
      .text(d => d.name);

    // Subtitle IPs
    nodeEnter.append('text')
      .attr('class', 'node-sub-label')
      .attr('text-anchor', 'middle')
      .attr('y', d => d.type === 'gateway' ? -16 : d.type === 'network' ? 48 : 38)
      .attr('fill', d => d.type === 'network' ? '#a855f7' : '#2496ed')
      .attr('font-size', '8px')
      .attr('font-family', 'monospace')
      .style('user-select', 'none')
      .style('pointer-events', 'none')
      .text(d => {
        if (d.type === 'gateway') return d.ip || '';
        if (d.type === 'network') return d.subnet || '';
        return d.ip || 'offline';
      });

    // Merge existing and new
    const nodeCombined = nodeEnter.merge(nodeSel);

    // Update state visuals (active/selected halos) in the update loop
    nodeCombined.select('.core-node')
      .attr('fill', d => {
        const isSelected = this.selectedNode()?.id === d.id;
        if (isSelected) {
          if (d.type === 'gateway') return '#0c4a6e';
          if (d.type === 'network') return '#3b0764';
          return '#14532d';
        }
        if (d.type === 'gateway') return '#0f172a';
        if (d.type === 'network') return '#111827';
        return d.status === 'running' ? '#1e1b4b' : '#0a0f1d';
      })
      .attr('stroke-width', d => {
        const isSelected = this.selectedNode()?.id === d.id;
        return isSelected ? 4.5 : (d.type === 'network' ? 3.0 : 2.0);
      })
      .attr('stroke', d => {
        const isSelected = this.selectedNode()?.id === d.id;
        if (isSelected) return '#38bdf8';
        if (d.type === 'gateway') return '#0284c7';
        if (d.type === 'network') return '#c084fc';
        return d.status === 'running' ? '#10b981' : '#475569';
      });

    // 5. Connect Drag Event Handlers with snapping detection
    const dragBehavior = d3.drag<SVGGElement, VisualizerNode>()
      .on('start', (event, d) => {
        if (d.type === 'gateway') return; // Keep loopback WAN fixed
        if (!event.active) this.simulation?.alphaTarget(0.2).restart();
        d.fx = d.x;
        d.fy = d.y;
        d.isDragging = true;
      })
      .on('drag', (event, d) => {
        if (d.type === 'gateway') return;
        d.fx = event.x;
        d.fy = event.y;
        
        // Dynamic drag indicators: highlight potential subnet snapping node in real-time
        if (d.type === 'container' && d.status === 'running') {
          let closestNetwork: VisualizerNode | null = null;
          let minDistance = 55;

          nodes.forEach(node => {
            if (node.type === 'network') {
              const dx = event.x - (node.x || 0);
              const dy = event.y - (node.y || 0);
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < minDistance) {
                minDistance = dist;
                closestNetwork = node;
              }
            }
          });

          // Style closest network core node dynamically during drag
          nodeCombined.select('.core-node')
            .attr('stroke', (nd: VisualizerNode) => {
              if (closestNetwork && nd.id === closestNetwork.id) {
                return '#f59e0b'; // Gold halo highlight for snap target
              }
              if (nd.type === 'gateway') return '#0284c7';
              if (nd.type === 'network') return '#c084fc';
              return nd.status === 'running' ? '#10b981' : '#475569';
            });
        }
      })
      .on('end', (event, d) => {
        if (d.type === 'gateway') return;
        if (!event.active) this.simulation?.alphaTarget(0);
        d.fx = null;
        d.fy = null;
        d.isDragging = false;

        // Trigger connection snapping mechanics on release
        if (d.type === 'container' && d.status === 'running' && d.containerId) {
          let closestNetwork: VisualizerNode | null = null;
          let minDistance = 55; // Snapping radius threshold

          nodes.forEach(node => {
            if (node.type === 'network') {
              const dx = event.x - (node.x || 0);
              const dy = event.y - (node.y || 0);
              const dist = Math.sqrt(dx * dx + dy * dy);
              if (dist < minDistance) {
                minDistance = dist;
                closestNetwork = node;
              }
            }
          });

          if (closestNetwork) {
            const targetNetworkName = (closestNetwork as VisualizerNode).name;
            if (d.network !== targetNetworkName) {
              // Emit re-route event
              this.moveContainer.emit({
                containerId: d.containerId,
                networkName: targetNetworkName
              });
            }
          }
        }

        // Reset any drag styling changes
        nodeCombined.select('.core-node')
          .attr('stroke', (nd: VisualizerNode) => {
            const isSelected = this.selectedNode()?.id === nd.id;
            if (isSelected) return '#38bdf8';
            if (nd.type === 'gateway') return '#0284c7';
            if (nd.type === 'network') return '#c084fc';
            return nd.status === 'running' ? '#10b981' : '#475569';
          });
      });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeCombined.call(dragBehavior as any);

    // 6. Connect D3 simulation tick updates
    this.simulation.on('tick', () => {
      // Draw lines
      linkCombined
        .attr('x1', d => {
          const s = d.source as VisualizerNode;
          return s.x || 0;
        })
        .attr('y1', d => {
          const s = d.source as VisualizerNode;
          return s.y || 0;
        })
        .attr('x2', d => {
          const t = d.target as VisualizerNode;
          return t.x || 0;
        })
        .attr('y2', d => {
          const t = d.target as VisualizerNode;
          return t.y || 0;
        });

      // Update Node positioning groups
      nodeCombined.attr('transform', d => `translate(${d.x || 0}, ${d.y || 0})`);
    });

    // Fire the simulation
    this.simulation.alpha(0.4).restart();
  }

  ngOnDestroy() {
    if (this.simulation) {
      this.simulation.stop();
      this.simulation = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }
}

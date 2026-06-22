import { Injectable, signal, computed } from '@angular/core';

export interface LayerCacheStatus {
  instruction: string;
  arguments: string;
  lineNumber: number;
  status: 'hit' | 'miss';
  cachedFromImageId?: string;
  cachedFromImageTag?: string;
  hash: string;
  sizeKb: number;
}

export interface BuildCacheReport {
  id: string;
  imageTag: string;
  timestamp: string;
  totalLayers: number;
  cachedLayersCount: number;
  sizeSavedMb: number;
  timeSavedSeconds: number;
  layers: LayerCacheStatus[];
}

@Injectable({
  providedIn: 'root'
})
export class DockerCacheService {
  // Store registry of built images and their layer compositions
  private builtImagesRegistry = signal<{ id: string; tag: string; layers: string[]; timestamp: string }[]>([
    {
      id: 'img-base-node',
      tag: 'node:18-alpine',
      layers: [
        'FROM node:18-alpine',
        'ENV NODE_ENV=production',
        'WORKDIR /app'
      ],
      timestamp: new Date(Date.now() - 3600000 * 2).toISOString()
    },
    {
      id: 'img-base-nginx',
      tag: 'nginx:alpine',
      layers: [
        'FROM nginx:alpine',
        'EXPOSE 80',
        'CMD ["nginx", "-g", "daemon off;"]'
      ],
      timestamp: new Date(Date.now() - 3605000 * 2).toISOString()
    }
  ]);

  // Track the history of executed build reports
  buildReports = signal<BuildCacheReport[]>([
    {
      id: 'rep-1',
      imageTag: 'prebuilt-node-warmup:latest',
      timestamp: new Date(Date.now() - 600000).toISOString(),
      totalLayers: 3,
      cachedLayersCount: 3,
      sizeSavedMb: 122.1,
      timeSavedSeconds: 12.5,
      layers: [
        { instruction: 'FROM', arguments: 'node:18-alpine', lineNumber: 1, status: 'hit', cachedFromImageId: 'img-base-node', cachedFromImageTag: 'node:18-alpine', hash: 'sha256:d81347072c', sizeKb: 122100 },
        { instruction: 'ENV', arguments: 'NODE_ENV=production', lineNumber: 2, status: 'hit', cachedFromImageId: 'img-base-node', cachedFromImageTag: 'node:18-alpine', hash: 'sha256:77ff1b069d', sizeKb: 0 },
        { instruction: 'WORKDIR', arguments: '/app', lineNumber: 3, status: 'hit', cachedFromImageId: 'img-base-node', cachedFromImageTag: 'node:18-alpine', hash: 'sha256:c3faec77b8', sizeKb: 0 }
      ]
    }
  ]);

  // Computed properties
  totalBuildsCount = computed(() => this.buildReports().length);
  
  averageCacheHitRate = computed(() => {
    const reports = this.buildReports();
    if (reports.length === 0) return 0;
    const totalLayers = reports.reduce((acc, curr) => acc + curr.totalLayers, 0);
    const cachedLayers = reports.reduce((acc, curr) => acc + curr.cachedLayersCount, 0);
    return totalLayers > 0 ? parseFloat(((cachedLayers / totalLayers) * 100).toFixed(1)) : 0;
  });

  totalStorageSavedMb = computed(() => {
    return parseFloat(this.buildReports().reduce((acc, curr) => acc + curr.sizeSavedMb, 0).toFixed(1));
  });

  totalBuildTimeSavedSeconds = computed(() => {
    return parseFloat(this.buildReports().reduce((acc, curr) => acc + curr.timeSavedSeconds, 0).toFixed(1));
  });

  /**
   * Helper to generate a deterministic stable hash for display
   */
  private generateLayerHash(instruction: string, args: string, index: number): string {
    const cleanStr = `${instruction.trim().toUpperCase()}_${args.trim().toLowerCase()}_${index}`;
    let hash = 0;
    for (let i = 0; i < cleanStr.length; i++) {
      const char = cleanStr.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return `sha256:${hex.substring(0, 10)}`;
  }

  /**
   * Evaluates the local layer tree structure in real-time.
   * Compares each line position sequentially. Once a layer has a mismatch vs. ALL previous 
   * successful configurations at that index position, it triggers a CACHE MISS, and all 
   * subsequent lines are ALSO designated copy-misses.
   */
  evaluateDockerfileCache(rawDockerfile: string): LayerCacheStatus[] {
    const lines = rawDockerfile.split('\n')
      .map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#'));

    const parsedLayers = lines.map((line, idx) => {
      const spaceIdx = line.indexOf(' ');
      let instruction = '';
      let args = '';
      if (spaceIdx > 0) {
        instruction = line.substring(0, spaceIdx).trim().toUpperCase();
        args = line.substring(spaceIdx + 1).trim();
      } else {
        instruction = line.toUpperCase();
      }
      return { instruction, arguments: args, originalLine: line, lineNumber: idx + 1 };
    });

    const activeRegistry = this.builtImagesRegistry();
    const evaluation: LayerCacheStatus[] = [];
    let cacheBroken = false;

    for (let i = 0; i < parsedLayers.length; i++) {
      const currentLayer = parsedLayers[i];
      const hash = this.generateLayerHash(currentLayer.instruction, currentLayer.arguments, i);
      let sizeKb = 0;

      // Estimate layer size overhead
      if (currentLayer.instruction === 'FROM') {
        sizeKb = 122100; // ~122.1 MB base image layer
      } else if (currentLayer.instruction === 'RUN') {
        sizeKb = Math.round(1000 + Math.random() * 20000); // 1-20 MB
      } else if (currentLayer.instruction === 'COPY') {
        sizeKb = Math.round(100 + Math.random() * 4000); // 0.1-4 MB
      }

      if (cacheBroken) {
        evaluation.push({
          instruction: currentLayer.instruction,
          arguments: currentLayer.arguments,
          lineNumber: currentLayer.lineNumber,
          status: 'miss',
          hash,
          sizeKb
        });
        continue;
      }

      // Check if we can find a matching ledger path in previously built images
      // To match in Docker, for layer index `i`, we must match index `0` to `i` exactly!
      let matchedImage: typeof activeRegistry[0] | undefined;

      for (const img of activeRegistry) {
        if (img.layers.length > i) {
          // Check if index 0 to i match exactly
          let match = true;
          for (let step = 0; step <= i; step++) {
            if (img.layers[step].trim().toLowerCase() !== parsedLayers[step].originalLine.trim().toLowerCase()) {
              match = false;
              break;
            }
          }
          if (match) {
            matchedImage = img;
            break;
          }
        }
      }

      if (matchedImage) {
        evaluation.push({
          instruction: currentLayer.instruction,
          arguments: currentLayer.arguments,
          lineNumber: currentLayer.lineNumber,
          status: 'hit',
          cachedFromImageId: matchedImage.id,
          cachedFromImageTag: matchedImage.tag,
          hash,
          sizeKb
        });
      } else {
        // Cache is invalidated at this index. All downstream layers must miss.
        cacheBroken = true;
        evaluation.push({
          instruction: currentLayer.instruction,
          arguments: currentLayer.arguments,
          lineNumber: currentLayer.lineNumber,
          status: 'miss',
          hash,
          sizeKb
        });
      }
    }

    return evaluation;
  }

  /**
   * Registers a newly completed build. Keeps the cache ledger up to date.
   */
  registerBuildAndFlushCache(
    imageId: string,
    imageTag: string,
    rawDockerfile: string,
    layers: string[]
  ): BuildCacheReport {
    // Evaluate hits and misses
    const evaluation = this.evaluateDockerfileCache(rawDockerfile);
    const cachedCount = evaluation.filter(e => e.status === 'hit').length;
    const totalCount = evaluation.length;

    // Compile metric savings
    let sizeSavedMb = 0;
    let timeSavedSeconds = 0;

    evaluation.forEach(layer => {
      if (layer.status === 'hit') {
        sizeSavedMb += parseFloat((layer.sizeKb / 1024).toFixed(2));
        timeSavedSeconds += layer.instruction === 'FROM' ? 8.0 : (layer.instruction === 'RUN' ? 4.5 : 1.5);
      }
    });

    const report: BuildCacheReport = {
      id: 'rep-' + Math.random().toString(36).substring(2, 8),
      imageTag,
      timestamp: new Date().toISOString(),
      totalLayers: totalCount,
      cachedLayersCount: cachedCount,
      sizeSavedMb: parseFloat(sizeSavedMb.toFixed(1)),
      timeSavedSeconds: parseFloat(timeSavedSeconds.toFixed(1)),
      layers: evaluation
    };

    // Append to reports list
    this.buildReports.update(arr => [report, ...arr]);

    // Insert this image into the registry so future builds can cache from it
    this.builtImagesRegistry.update(arr => [
      ...arr,
      {
        id: imageId,
        tag: imageTag,
        layers: layers,
        timestamp: new Date().toISOString()
      }
    ]);

    return report;
  }

  /**
   * Resets build cache ledger simulator stats
   */
  clearCacheSimulationLedger() {
    this.buildReports.set([]);
    this.builtImagesRegistry.set([
      {
        id: 'img-base-node',
        tag: 'node:18-alpine',
        layers: [
          'FROM node:18-alpine',
          'ENV NODE_ENV=production',
          'WORKDIR /app'
        ],
        timestamp: new Date().toISOString()
      },
      {
        id: 'img-base-nginx',
        tag: 'nginx:alpine',
        layers: [
          'FROM nginx:alpine',
          'EXPOSE 80',
          'CMD ["nginx", "-g", "daemon off;"]'
        ],
        timestamp: new Date().toISOString()
      }
    ]);
  }
}

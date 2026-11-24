import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import type { EmbeddingModel } from '../ports/index.js';

/**
 * Singleton ONNX embedding adapter using Xenova/all-MiniLM-L6-v2 (quantized q8, 384 dims).
 * Guaranteed identical across local Docker, CI, and Vercel production.
 */
export class TransformersEmbeddingModel implements EmbeddingModel {
  private static extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
  private static ready = false;

  public isReady(): boolean {
    return TransformersEmbeddingModel.ready;
  }

  private async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!TransformersEmbeddingModel.extractorPromise) {
      TransformersEmbeddingModel.extractorPromise = (
        pipeline as unknown as (
          task: 'feature-extraction',
          model: string,
          options: { dtype: 'q8' },
        ) => Promise<FeatureExtractionPipeline>
      )('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'q8',
      })
        .then((ext) => {
          TransformersEmbeddingModel.ready = true;
          return ext;
        })
        .catch((err: unknown) => {
          TransformersEmbeddingModel.extractorPromise = null;
          TransformersEmbeddingModel.ready = false;
          throw err;
        });
    }
    return TransformersEmbeddingModel.extractorPromise;
  }

  public async warmup(): Promise<void> {
    await this.embed('warmup');
  }

  public async embed(text: string): Promise<number[]> {
    const extractor = await this.getExtractor();
    const output = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    });
    const vector = Array.from(output.data as Float32Array);
    if (vector.length !== 384) {
      throw new Error(`Expected 384-dim embedding vector, received ${vector.length}`);
    }
    return vector;
  }
}

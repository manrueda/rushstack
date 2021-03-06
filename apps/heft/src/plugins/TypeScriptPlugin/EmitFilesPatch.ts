// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import { InternalError } from '@rushstack/node-core-library';
import type * as TTypescript from 'typescript';
import {
  ExtendedTypeScript,
  IEmitResolver,
  IEmitHost,
  IEmitTransformers,
  IExtendedSourceFile
} from './internalTypings/TypeScriptInternals';

export interface ICachedEmitModuleKind {
  moduleKind: TTypescript.ModuleKind;

  outFolderPath: string;

  /**
   * TypeScript's output is placed in the \<project root\>/.heft/build-cache folder.
   * This is the the path to the subfolder in the build-cache folder that this emit kind
   * written to.
   */
  cacheOutFolderPath: string;

  /**
   * Set to true if this is the emit kind that is specified in the tsconfig.json.
   * Declarations are only emitted for the primary module kind.
   */
  isPrimary: boolean;
}

export class EmitFilesPatch {
  private static _patchedTs: ExtendedTypeScript | undefined = undefined;

  // eslint-disable-next-line
  private static _baseEmitFiles: any | undefined = undefined;

  public static install(
    ts: ExtendedTypeScript,
    tsconfig: TTypescript.ParsedCommandLine,
    moduleKindsToEmit: ICachedEmitModuleKind[],
    useBuildCache: boolean,
    changedFiles?: Set<IExtendedSourceFile>
  ): void {
    if (EmitFilesPatch._patchedTs !== undefined) {
      throw new InternalError(
        'EmitFilesPatch.install() cannot be called without first uninstalling the existing patch'
      );
    }
    EmitFilesPatch._patchedTs = ts;
    EmitFilesPatch._baseEmitFiles = ts.emitFiles;

    let foundPrimary: boolean = false;
    let defaultModuleKind: TTypescript.ModuleKind;

    const compilerOptionsMap: Map<ICachedEmitModuleKind, TTypescript.CompilerOptions> = new Map();

    for (const moduleKindToEmit of moduleKindsToEmit) {
      const outDir: string = useBuildCache
        ? moduleKindToEmit.cacheOutFolderPath
        : moduleKindToEmit.outFolderPath;
      if (moduleKindToEmit.isPrimary) {
        if (foundPrimary) {
          throw new Error('Multiple primary module emit kinds encountered.');
        } else {
          foundPrimary = true;
        }
        defaultModuleKind = moduleKindToEmit.moduleKind;
        compilerOptionsMap.set(moduleKindToEmit, {
          ...tsconfig.options,
          outDir
        });
      } else {
        compilerOptionsMap.set(moduleKindToEmit, {
          ...tsconfig.options,
          outDir,
          module: moduleKindToEmit.moduleKind,
          // Don't emit declarations for secondary module kinds
          declaration: false,
          declarationMap: false
        });
      }
    }

    // Override the underlying file emitter to run itself once for each flavor
    // This is a rather inelegant way to convince the TypeScript compiler not to duplicate parse/link/check
    ts.emitFiles = (
      resolver: IEmitResolver,
      host: IEmitHost,
      targetSourceFile: IExtendedSourceFile | undefined,
      emitTransformers: IEmitTransformers,
      emitOnlyDtsFiles?: boolean,
      onlyBuildInfo?: boolean,
      forceDtsEmit?: boolean
    ): TTypescript.EmitResult => {
      if (onlyBuildInfo || emitOnlyDtsFiles) {
        // There should only be one tsBuildInfo and one set of declaration files
        return EmitFilesPatch._baseEmitFiles(
          resolver,
          host,
          targetSourceFile,
          emitTransformers,
          emitOnlyDtsFiles,
          onlyBuildInfo,
          forceDtsEmit
        );
      } else {
        if (targetSourceFile && changedFiles) {
          changedFiles.add(targetSourceFile);
        }

        let defaultModuleKindResult: TTypescript.EmitResult;
        let emitSkipped: boolean = false;
        for (const moduleKindToEmit of moduleKindsToEmit) {
          const compilerOptions: TTypescript.CompilerOptions = compilerOptionsMap.get(moduleKindToEmit)!;

          if (!compilerOptions.outDir) {
            throw new InternalError('Expected compilerOptions.outDir to be assigned');
          }

          const flavorResult: TTypescript.EmitResult = EmitFilesPatch._baseEmitFiles(
            resolver,
            {
              ...host,
              getCompilerOptions: () => compilerOptions
            },
            targetSourceFile,
            ts.getTransformers(compilerOptions, undefined, emitOnlyDtsFiles),
            emitOnlyDtsFiles,
            onlyBuildInfo,
            forceDtsEmit
          );

          emitSkipped = emitSkipped || flavorResult.emitSkipped;
          if (moduleKindToEmit.moduleKind === defaultModuleKind) {
            defaultModuleKindResult = flavorResult;
          }
          // Should results be aggregated, in case for whatever reason the diagnostics are not the same?
        }
        return {
          ...defaultModuleKindResult!,
          emitSkipped
        };
      }
    };
  }

  public static get isInstalled(): boolean {
    return this._patchedTs !== undefined;
  }

  public static uninstall(ts: ExtendedTypeScript): void {
    if (EmitFilesPatch._patchedTs === undefined) {
      throw new InternalError('EmitFilesPatch.uninstall() cannot be called if no patch was installed');
    }
    if (ts !== EmitFilesPatch._patchedTs) {
      throw new InternalError('EmitFilesPatch.uninstall() called for the wrong object');
    }

    ts.emitFiles = EmitFilesPatch._baseEmitFiles;

    EmitFilesPatch._patchedTs = undefined;
    EmitFilesPatch._baseEmitFiles = undefined;
  }
}

// Based on https://codepen.io/inlet/pen/yLVmPWv.
// Copyright (c) 2018 Patrick Brouwer, distributed under the MIT license.

import { PixiComponent, useApp } from '@pixi/react';
import { Viewport } from 'pixi-viewport';
import { Application } from 'pixi.js';
import { MutableRefObject, ReactNode } from 'react';

export type ViewportProps = {
  app: Application;
  viewportRef?: MutableRefObject<Viewport | undefined>;

  screenWidth: number;
  screenHeight: number;
  worldWidth: number;
  worldHeight: number;
  children?: ReactNode;
};

function fitScale(props: Pick<ViewportProps, 'screenWidth' | 'screenHeight' | 'worldWidth' | 'worldHeight'>) {
  const xScale = props.screenWidth / Math.max(1, props.worldWidth);
  const yScale = props.screenHeight / Math.max(1, props.worldHeight);
  return Math.min(xScale, yScale) * 0.94;
}

// https://davidfig.github.io/pixi-viewport/jsdoc/Viewport.html
export default PixiComponent('Viewport', {
  create(props: ViewportProps) {
    const { app, children, viewportRef, ...viewportProps } = props;
    const viewport = new Viewport({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      events: app.renderer.events,
      passiveWheel: false,
      ...viewportProps,
    });
    if (viewportRef) {
      viewportRef.current = viewport;
    }
    // Activate plugins
    viewport
      .drag()
      .pinch({})
      .wheel()
      .decelerate()
      .clamp({ direction: 'all', underflow: 'center' })
      .clampZoom({
        minScale: fitScale(props),
        maxScale: 3.0,
      });
    viewport.fitWorld(true);
    return viewport;
  },
  applyProps(viewport, oldProps: any, newProps: any) {
    Object.keys(newProps).forEach((p) => {
      if (p !== 'app' && p !== 'viewportRef' && p !== 'children' && oldProps[p] !== newProps[p]) {
        // @ts-expect-error Ignoring TypeScript here
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        viewport[p] = newProps[p];
      }
    });
    if (
      oldProps.screenWidth !== newProps.screenWidth
      || oldProps.screenHeight !== newProps.screenHeight
      || oldProps.worldWidth !== newProps.worldWidth
      || oldProps.worldHeight !== newProps.worldHeight
    ) {
      viewport.clampZoom({
        minScale: fitScale(newProps),
        maxScale: 3.0,
      });
      viewport.fitWorld(true);
    }
  },
});

import { BaseTexture, ISpritesheetData, Spritesheet } from 'pixi.js';
import { useState, useEffect, useRef, useCallback } from 'react';
import { AnimatedSprite, Container, Graphics, Text } from '@pixi/react';
import * as PIXI from 'pixi.js';

export const Character = ({
  textureUrl,
  spritesheetData,
  x,
  y,
  orientation,
  isMoving = false,
  isThinking = false,
  isSpeaking = false,
  emoji = '',
  overlayText = '',
  overlayTone = 'neutral',
  isViewer = false,
  speed = 0.1,
  onClick,
}: {
  // Path to the texture packed image.
  textureUrl: string;
  // The data for the spritesheet.
  spritesheetData: ISpritesheetData;
  // The pose of the NPC.
  x: number;
  y: number;
  orientation: number;
  isMoving?: boolean;
  // Shows a thought bubble if true.
  isThinking?: boolean;
  // Shows a speech bubble if true.
  isSpeaking?: boolean;
  emoji?: string;
  overlayText?: string;
  overlayTone?: 'neutral' | 'chat' | 'busy' | 'trade' | 'warning';
  // Highlights the player.
  isViewer?: boolean;
  // The speed of the animation. Can be tuned depending on the side and speed of the NPC.
  speed?: number;
  onClick: () => void;
}) => {
  const [spriteSheet, setSpriteSheet] = useState<Spritesheet>();
  useEffect(() => {
    const parseSheet = async () => {
      const sheet = new Spritesheet(
        BaseTexture.from(textureUrl, {
          scaleMode: PIXI.SCALE_MODES.NEAREST,
        }),
        spritesheetData,
      );
      await sheet.parse();
      setSpriteSheet(sheet);
    };
    void parseSheet();
  }, []);

  // The first "left" is "right" but reflected.
  const roundedOrientation = Math.floor(orientation / 90);
  const direction = ['right', 'down', 'left', 'up'][roundedOrientation];

  // Prevents the animation from stopping when the texture changes
  // (see https://github.com/pixijs/pixi-react/issues/359)
  const ref = useRef<PIXI.AnimatedSprite | null>(null);
  useEffect(() => {
    if (isMoving) {
      ref.current?.play();
    }
  }, [direction, isMoving]);

  if (!spriteSheet) return null;

  let blockOffset = { x: 0, y: 0 };
  switch (roundedOrientation) {
    case 2:
      blockOffset = { x: -20, y: 0 };
      break;
    case 0:
      blockOffset = { x: 20, y: 0 };
      break;
    case 3:
      blockOffset = { x: 0, y: -20 };
      break;
    case 1:
      blockOffset = { x: 0, y: 20 };
      break;
  }

  return (
    <Container x={x} y={y} interactive={true} pointerdown={onClick} cursor="pointer">
      {isThinking && (
        // TODO: We'll eventually have separate assets for thinking and speech animations.
        <Text x={-20} y={-10} scale={{ x: -0.8, y: 0.8 }} text={'💭'} anchor={{ x: 0.5, y: 0.5 }} />
      )}
      {isSpeaking && (
        // TODO: We'll eventually have separate assets for thinking and speech animations.
        <Text x={18} y={-10} scale={0.8} text={'💬'} anchor={{ x: 0.5, y: 0.5 }} />
      )}
      {isViewer && <ViewerIndicator />}
      {overlayText && <StatusBubble text={overlayText} tone={overlayTone} />}
      <AnimatedSprite
        ref={ref}
        isPlaying={isMoving}
        textures={spriteSheet.animations[direction]}
        animationSpeed={speed}
        anchor={{ x: 0.5, y: 0.5 }}
      />
      {emoji && (
        <Text x={0} y={-24} scale={{ x: -0.8, y: 0.8 }} text={emoji} anchor={{ x: 0.5, y: 0.5 }} />
      )}
    </Container>
  );
};

function ViewerIndicator() {
  const draw = useCallback((g: PIXI.Graphics) => {
    g.clear();
    g.beginFill(0xffff0b, 0.5);
    g.drawRoundedRect(-10, 10, 20, 10, 100);
    g.endFill();
  }, []);

  return <Graphics draw={draw} />;
}

function StatusBubble({
  text,
  tone,
}: {
  text: string;
  tone: 'neutral' | 'chat' | 'busy' | 'trade' | 'warning';
}) {
  const bubbleText = text.length > 42 ? `${text.slice(0, 39)}...` : text;
  const width = Math.max(72, Math.min(188, bubbleText.length * 6.6 + 18));
  const height = 24;
  const palette: Record<typeof tone, { fill: number; alpha: number; stroke: number }> = {
    neutral: { fill: 0x1d1b17, alpha: 0.88, stroke: 0xcab58e },
    chat: { fill: 0x294b63, alpha: 0.92, stroke: 0xb6def2 },
    busy: { fill: 0x47561d, alpha: 0.92, stroke: 0xd2ec8d },
    trade: { fill: 0x5a3a11, alpha: 0.92, stroke: 0xf3cf89 },
    warning: { fill: 0x5b1f22, alpha: 0.92, stroke: 0xf1a9ae },
  };
  const colors = palette[tone];
  const draw = useCallback((g: PIXI.Graphics) => {
    g.clear();
    g.lineStyle(1.5, colors.stroke, 0.95);
    g.beginFill(colors.fill, colors.alpha);
    g.drawRoundedRect(-width / 2, -52, width, height, 8);
    g.endFill();
  }, [colors, width]);

  return (
    <Container>
      <Graphics draw={draw} />
      <Text
        x={0}
        y={-40}
        text={bubbleText}
        anchor={{ x: 0.5, y: 0.5 }}
        style={
          new PIXI.TextStyle({
            fill: '#f7f0dc',
            fontSize: 10,
            fontFamily: 'Georgia',
            align: 'center',
            wordWrap: false,
          })
        }
        scale={0.92}
      />
    </Container>
  );
}

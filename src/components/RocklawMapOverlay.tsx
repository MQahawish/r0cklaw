import { Container, Graphics, Text } from '@pixi/react';
import * as PIXI from 'pixi.js';
import { useMemo } from 'react';
import { ROCKLAW_PLACE_LIST } from '../../convex/rocklaw/mapLayout';

export function RocklawMapOverlay({
  tileDim,
  liveScenes,
}: {
  tileDim: number;
  liveScenes: Array<{ sceneId: string; left: string; right: string; location: string }>;
}) {
  const activeLocations = useMemo(
    () => new Set(liveScenes.map((scene) => scene.location)),
    [liveScenes],
  );

  return (
    <Container>
      {ROCKLAW_PLACE_LIST.map((place) => {
        const isActive = activeLocations.has(place.key);
        const draw = (g: PIXI.Graphics) => {
          g.clear();
          g.lineStyle(2, isActive ? 0xf6d57b : place.color, isActive ? 0.9 : 0.55);
          g.beginFill(place.color, isActive ? 0.14 : 0.08);
          g.drawRoundedRect(
            place.region.x * tileDim,
            place.region.y * tileDim,
            place.region.width * tileDim,
            place.region.height * tileDim,
            14,
          );
          g.endFill();
        };
        return (
          <Container key={place.key}>
            <Graphics draw={draw} />
            <Text
              x={(place.center.x + place.labelOffset.x) * tileDim}
              y={(place.center.y + place.labelOffset.y) * tileDim}
              anchor={{ x: 0.5, y: 0.5 }}
              text={place.label}
              style={
                new PIXI.TextStyle({
                  fill: isActive ? '#fff7d0' : '#ead9b5',
                  fontSize: 13,
                  fontFamily: 'Georgia',
                  fontWeight: '700',
                  stroke: '#1d130d',
                  strokeThickness: 3,
                  letterSpacing: 0.8,
                })
              }
              scale={1}
            />
          </Container>
        );
      })}
      {liveScenes.map((scene) => {
        const place = ROCKLAW_PLACE_LIST.find((entry) => entry.key === scene.location);
        if (!place) return null;
        const draw = (g: PIXI.Graphics) => {
          g.clear();
          const [a, b] = place.sceneSlots;
          if (!a || !b) return;
          g.lineStyle(2.5, 0xf5dc99, 0.9);
          g.moveTo(a.x * tileDim + tileDim / 2, a.y * tileDim + tileDim / 2);
          g.lineTo(b.x * tileDim + tileDim / 2, b.y * tileDim + tileDim / 2);
        };
        return <Graphics key={scene.sceneId} draw={draw} />;
      })}
    </Container>
  );
}

"""Export our exact v2 2026 Tesla Roadster (ROSTR) voxel grid to Three.js JSON.

Reuses the 52 x 116 x 30 symmetric voxel design from rostr_v2_stack.py,
splits into articulated parts (chassis, active spoiler, 4 wheels, 4 suction fans),
culls completely buried interior voxels (6-neighbor), and outputs meter coordinates
(+X left, +Y up, +Z forward nose, tire ground at Y=0).
"""
import json
import math
import os
import numpy as np

L_CAR, W, H_CAR = 116, 52, 30
CX = (W - 1) / 2.0
VOXEL_SIZE = 0.039

# Material tags: 0=body/matte, 1=glass, 2=metal/nozzle, 3=emissiveHead, 4=emissiveTail, 5=emissiveAmber
MAT_BODY, MAT_GLASS, MAT_METAL, MAT_HEAD, MAT_TAIL, MAT_AMBER = 0, 1, 2, 3, 4, 5

WHITE_TOP = (245, 247, 251)
WHITE_HOOD = (228, 233, 242)
WHITE_FACET = (205, 213, 228)
WHITE_SIDE = (168, 178, 198)
WHITE_SHADE = (128, 138, 158)
SILVER = (192, 200, 216)
SKIRT = (24, 26, 34)
SKIRT_TOP = (44, 48, 58)
TIRE = (20, 22, 28)
SPOKE = (38, 42, 52)
GLASS_DARK = (31, 21, 18)
GLASS_MID = (48, 33, 27)
GLASS_EDGE = (66, 46, 38)
GLASS_HI = (123, 93, 77)
GLASS_GLINT = (174, 139, 118)
GLASS_SPARK = (214, 183, 164)
NOZZLE_BRONZE = (196, 152, 92)
NOZZLE_BORE = (14, 14, 18)
FAN_RING = (64, 68, 82)
HEAD_LED = (252, 254, 255)
HEAD_BEZEL = (40, 44, 54)
TAIL_RED = (255, 32, 52)
TAIL_HI = (255, 118, 118)
AMBER = (255, 150, 36)
AMBER_HI = (255, 210, 128)
VENT_DARK = (18, 20, 26)

PART_NAMES = [
    'chassis', 'spoiler',
    'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR',
    'fan0', 'fan1', 'fan2', 'fan3',
]
PART_ID = {name: idx for idx, name in enumerate(PART_NAMES)}

occ = np.zeros((H_CAR, L_CAR, W), dtype=bool)
col_grid = np.zeros((H_CAR, L_CAR, W, 3), dtype=np.uint8)
mat_grid = np.zeros((H_CAR, L_CAR, W), dtype=np.uint8)
part_grid = np.zeros((H_CAR, L_CAR, W), dtype=np.uint8)


def set_vox(zc, yc, x, col, mat=MAT_BODY, part='chassis'):
  if 0 <= zc < H_CAR and 0 <= yc < L_CAR and 0 <= x < W:
    occ[zc, yc, x] = True
    col_grid[zc, yc, x] = col
    mat_grid[zc, yc, x] = mat
    part_grid[zc, yc, x] = PART_ID[part]


def lerp(a, b, t):
  t = max(0.0, min(1.0, t))
  return a + (b - a) * t


def smoothstep(e0, e1, x):
  t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
  return t * t * (3.0 - 2.0 * t)


def body_half_width(yc):
  if yc < 24:
    return lerp(21.6, 25.2, smoothstep(0, 24, yc))
  if yc < 40:
    return lerp(25.2, 23.0, smoothstep(24, 40, yc))
  if yc < 72:
    return 23.0
  if yc < 92:
    return lerp(23.0, 24.2, smoothstep(72, 92, yc))
  if yc < 100:
    return lerp(24.2, 23.2, smoothstep(92, 100, yc))
  return lerp(23.2, 16.4, smoothstep(100, 115, yc) ** 0.9)


def canopy_profile(yc):
  if yc < 12 or yc > 82:
    return 0.0, 0.0, 0.0
  if yc <= 52:
    t = (yc - 12) / 40.0
    hw_base = lerp(2.4, 18.0, t ** 0.72)
    hw_top = lerp(1.2, 10.8, t ** 0.86)
    z_top = lerp(20.4, 29.1, math.sin(t * math.pi * 0.5) ** 0.85)
    return hw_base, hw_top, z_top
  t = (yc - 52) / 30.0
  hw_base = lerp(18.0, 14.4, t ** 1.15)
  hw_top = lerp(10.8, 11.4, t)
  z_top = lerp(29.1, 18.0, t ** 1.05)
  return hw_base, hw_top, z_top


def hood_deck_height(yc, dx, hw):
  if yc >= 80:
    t_nose = (115 - yc) / 35.0
    z_center = lerp(10.6, 18.0, t_nose ** 0.86)
    fender_ridge = 16.4 + 0.08 * (92 - yc)
    z_fender = lerp(12.6, 19.8, t_nose ** 0.72)
    if dx <= 12.4:
      return z_center
    if dx <= fender_ridge:
      return lerp(z_center, z_fender, (dx - 12.4) / max(0.8, fender_ridge - 12.4))
    drop = (dx - fender_ridge) / max(1.2, hw - fender_ridge)
    arch_guard = 1.0 if abs(yc - 92) <= 8 else 1.5
    return z_fender - arch_guard * drop
  if yc >= 28:
    z_belt = lerp(21.2, 18.4, (yc - 28) / 52.0)
  else:
    z_belt = lerp(20.0, 21.2, yc / 28.0)
  if dx > hw - 2.4 and abs(yc - 26) > 8:
    return z_belt - 1.0
  return z_belt


AXLE_REAR, AXLE_FRONT = 26, 92
WHEEL_R = 7.9
WHEEL_Z = 7.7

# 1. Body & canopy
for yc in range(L_CAR):
  hw = body_half_width(yc)
  hw_cb, hw_ct, z_canopy_top = canopy_profile(yc)
  for x in range(W):
    dx = abs(x - CX)
    if dx > hw + 0.2:
      continue
    z_bot = 4
    if yc >= 112 and dx > 16.2:
      z_bot = 6
    if yc <= 3 and dx > 17.0:
      z_bot = 6

    z_body_top = hood_deck_height(yc, dx, hw)
    in_canopy = False
    is_rail = False
    z_surf = z_body_top

    if 12 <= yc <= 82 and dx <= hw_cb + 1.5:
      if dx <= hw_ct:
        z_surf = max(z_body_top, z_canopy_top)
        in_canopy = True
      elif dx <= hw_cb:
        frac = (dx - hw_ct) / max(0.8, hw_cb - hw_ct)
        z_dome = lerp(z_canopy_top, hood_deck_height(yc, hw_cb, hw), frac ** 1.15)
        if z_dome > z_body_top + 0.45:
          z_surf = z_dome
          in_canopy = True
          if 44 <= yc <= 80 and dx >= hw_cb - 1.7:
            in_canopy = False
            is_rail = True

    z_max = int(round(z_surf))
    if z_max < z_bot:
      continue

    skirt_h = 4
    if dx >= hw - 3.2:
      if 35 <= yc <= 84:
        t_sk = smoothstep(70, 35, yc)
        skirt_h = int(round(lerp(6.0, 8.0, t_sk)))
      elif yc <= 9 or yc >= 108:
        skirt_h = 7 if yc <= 8 else 6

    for zc in range(z_bot, z_max + 1):
      in_rear_well = abs(yc - AXLE_REAR) <= 8.8 and dx >= hw - 5.4 and zc <= 15
      in_front_well = abs(yc - AXLE_FRONT) <= 8.8 and dx >= hw - 5.4 and zc <= 15
      if in_rear_well or in_front_well:
        continue
      if yc <= 4 and zc <= 11 and dx <= 17.2:
        set_vox(zc, yc, x, VENT_DARK)
        continue
      if yc <= 4 and 12 <= zc <= 17 and dx >= 19.0:
        set_vox(zc, yc, x, VENT_DARK)
        continue
      if yc >= 110 and 5 <= zc <= 9 and dx <= 15.6:
        set_vox(zc, yc, x, SKIRT)
        continue

      if in_canopy and zc >= int(round(z_body_top)):
        diag = (x - CX) * 0.45 + (yc - 60) * 0.35
        if zc >= z_max - 1 and yc >= 42 and -4.0 < diag < 1.6:
          if zc == z_max and -1.8 < diag < 0.0 and yc >= 50:
            c = GLASS_SPARK
          elif -2.6 < diag < 0.6:
            c = GLASS_GLINT
          else:
            c = GLASS_HI
        elif zc >= z_max - 1 and yc >= 48:
          c = GLASS_EDGE
        elif zc >= z_max - 2:
          c = GLASS_MID
        else:
          c = GLASS_DARK
        set_vox(zc, yc, x, c, MAT_GLASS)
      elif is_rail and zc >= int(round(z_body_top)):
        if yc >= 56 or zc >= z_max - 1:
          set_vox(zc, yc, x, WHITE_TOP if zc == z_max else WHITE_FACET)
        else:
          set_vox(zc, yc, x, GLASS_DARK, MAT_GLASS)
      elif zc <= skirt_h and dx >= hw - 3.3:
        set_vox(zc, yc, x, SKIRT_TOP if zc == skirt_h else SKIRT)
      elif zc == z_bot:
        set_vox(zc, yc, x, SKIRT)
      else:
        if zc == z_max:
          if yc >= 113 and dx <= 15.0:
            c = WHITE_FACET
          elif yc >= 80 and dx <= 12.2:
            c = WHITE_HOOD
          elif yc >= 80 and dx > 18.0:
            c = WHITE_FACET
          elif dx > hw - 1.8:
            c = WHITE_FACET
          else:
            c = WHITE_TOP
        elif zc >= z_max - 2:
          c = WHITE_FACET if dx > hw - 2.6 else WHITE_TOP
        else:
          c = WHITE_SIDE if dx > hw - 2.6 else WHITE_SHADE
        set_vox(zc, yc, x, c)

# 2. Side windows + B-pillar
for yc in range(28, 74):
  hw_cb, hw_ct, z_canopy_top = canopy_profile(yc)
  hw = body_half_width(yc)
  z_b = hood_deck_height(yc, hw_cb, hw)
  for zc in range(int(round(z_b)) + 1, int(round(z_canopy_top))):
    if 48 <= yc <= 50:
      for side in (-1, 1):
        x = int(round(CX + side * hw_cb))
        if 0 <= x < W and occ[zc, yc, x]:
          set_vox(zc, yc, x, WHITE_FACET if zc < z_canopy_top - 1 else WHITE_TOP)
      continue
    if yc < 48 and zc > lerp(z_b + 1.5, z_canopy_top - 1.5, (yc - 28) / 20.0):
      continue
    for side in (-1, 1):
      x = int(round(CX + side * hw_cb))
      if 0 <= x < W and occ[zc, yc, x] and zc < z_canopy_top - 1:
        set_vox(zc, yc, x, GLASS_DARK if zc < z_canopy_top - 2 else GLASS_MID, MAT_GLASS)

# 3. Fender arch lips & seams
for ay in (AXLE_REAR, AXLE_FRONT):
  hw_a = body_half_width(ay)
  for yc in range(ay - 10, ay + 11):
    for zc in range(4, 16):
      d = math.hypot(yc - ay, zc - WHEEL_Z)
      if 8.15 <= d <= 9.65:
        for side in (-1, 1):
          x = int(round(CX + side * (hw_a - 0.5)))
          if 0 <= x < W and occ[zc, yc, x]:
            set_vox(zc, yc, x, SKIRT_TOP)

for yc in range(81, 113):
  z_edge = int(round(hood_deck_height(yc, 12.4, body_half_width(yc))))
  for side in (-1, 1):
    set_vox(z_edge, yc, int(round(CX + side * 12.4)), WHITE_FACET)
for x in range(W):
  if abs(x - CX) <= 12.2:
    z_f = int(round(hood_deck_height(105, abs(x - CX), body_half_width(105))))
    set_vox(z_f, 105, x, WHITE_FACET)
for zc in range(8, 19):
  for side in (-1, 1):
    x = int(round(CX + side * 23.0))
    if occ[zc, 46, x]:
      set_vox(zc, 46, x, WHITE_SHADE)

# 4. 4 individual 17x17 5-spoke aero wheels (+X is Left, -X is Right)
wheel_pivots = {}
for ay, wname_l, wname_r in ((AXLE_FRONT, 'wheelFL', 'wheelFR'), (AXLE_REAR, 'wheelRL', 'wheelRR')):
  hw_a = body_half_width(ay)
  wheel_pivots[wname_l] = [round((hw_a - 2.2) * VOXEL_SIZE, 4), round(WHEEL_Z * VOXEL_SIZE, 4), round((ay - 57.5) * VOXEL_SIZE, 4)]
  wheel_pivots[wname_r] = [round(-(hw_a - 2.2) * VOXEL_SIZE, 4), round(WHEEL_Z * VOXEL_SIZE, 4), round((ay - 57.5) * VOXEL_SIZE, 4)]
  for yc in range(ay - 9, ay + 10):
    for zc in range(0, 16):
      d = math.hypot(yc - ay, zc - WHEEL_Z)
      if d > WHEEL_R:
        continue
      ang = math.atan2(zc - WHEEL_Z, yc - ay)
      sector = (ang * 5.0 / (2.0 * math.pi)) % 1.0
      for side, wpart in ((1, wname_l), (-1, wname_r)):
        for off in (0.4, 1.4, 2.5, 3.6, 4.5):
          x = int(round(CX + side * (hw_a - off)))
          if not (0 <= x < W):
            continue
          mat = MAT_BODY
          if off < 1.8:
            if d <= 0.9:
              c, mat = SILVER, MAT_METAL
            elif d <= 1.8:
              c = SPOKE
            elif d <= 5.5:
              if sector < 0.48:
                c, mat = (WHITE_FACET if d <= 4.3 else SILVER), MAT_METAL
              else:
                c = SPOKE
            elif d <= 6.1:
              c, mat = SILVER, MAT_METAL
            else:
              c = TIRE
          else:
            c = TIRE
          set_vox(zc, yc, x, c, mat, wpart)

# 5. Front fascia: LED bar, headlights, side markers
for x in range(W):
  dx = abs(x - CX)
  if dx <= 15.0:
    set_vox(10, 115, x, HEAD_LED, MAT_HEAD)
  for yc, bez, led in (
      (112, (12.4, 15.8), (12.6, 15.0)),
      (111, (12.2, 16.4), (12.4, 15.8)),
      (110, (12.2, 16.6), (12.4, 16.0)),
      (109, (12.6, 16.8), (12.8, 16.4)),
      (108, (13.4, 16.8), (13.8, 16.5)),
      (107, (14.5, 16.8), (15.0, 16.4)),
  ):
    if bez[0] <= dx <= bez[1]:
      z_h = int(round(hood_deck_height(yc, dx, body_half_width(yc))))
      set_vox(z_h - 1, yc, x, HEAD_BEZEL)
      if led[0] <= dx <= led[1]:
        set_vox(z_h, yc, x, HEAD_LED, MAT_HEAD)
        if yc in (110, 111):
          set_vox(z_h - 1, yc, x, HEAD_LED, MAT_HEAD)

for side in (-1, 1):
  x = int(round(CX + side * 23.0))
  set_vox(13, 78, x, HEAD_BEZEL)
  set_vox(14, 78, x, AMBER, MAT_AMBER)
  set_vox(14, 79, x, AMBER_HI, MAT_AMBER)
  set_vox(14, 80, x, AMBER, MAT_AMBER)
  set_vox(13, 81, x, HEAD_BEZEL)

# 6. Rear fascia: red taillight bar, ROSTR plate, diffuser strakes, 4 bronze nozzles, 4 fan impellers
for x in range(W):
  dx = abs(x - CX)
  if dx <= 21.2:
    set_vox(18, 0, x, TAIL_RED, MAT_TAIL)
    set_vox(19, 0, x, TAIL_HI if dx <= 19.0 else TAIL_RED, MAT_TAIL)
    if dx >= 18.0:
      for yc in (1, 2, 3, 4):
        set_vox(18, yc, x, TAIL_RED, MAT_TAIL)
  if dx <= 5.5:
    for zc in (13, 14, 15):
      set_vox(zc, 0, x, SILVER if zc != 14 or dx > 4.2 else WHITE_HOOD, MAT_METAL)

for sx in (15, 20, 25, 26, 31, 36):
  for zc in range(4, 9):
    set_vox(zc, 0, sx, SKIRT_TOP)

fan_pivots = {}
for idx_f, cx_n in enumerate((15, 22, 29, 36)):
  fname = f'fan{idx_f}'
  fan_pivots[fname] = [round((cx_n - CX) * VOXEL_SIZE, 4), round(6.5 * VOXEL_SIZE, 4), round((0.5 - 57.5) * VOXEL_SIZE, 4)]
  for dx_n in (-1, 0, 1):
    for dz_n in (-1, 0, 1):
      is_bore = (dx_n == 0 and dz_n == 0)
      c_n = NOZZLE_BORE if is_bore else NOZZLE_BRONZE
      m_n = MAT_BODY if is_bore else MAT_METAL
      set_vox(10 + dz_n, 0, cx_n + dx_n, c_n, m_n)
      set_vox(10 + dz_n, 1, cx_n + dx_n, c_n, m_n)
    # Shroud ring on chassis, inner fan blades on fan0..fan3
    for zc_f in (5, 6, 7, 8):
      is_edge = abs(dx_n) == 1 or zc_f in (5, 8)
      if is_edge:
        set_vox(zc_f, 0, cx_n + dx_n, FAN_RING, MAT_METAL, 'chassis')
      else:
        c_f = SILVER if zc_f == 6 and dx_n == 0 else SPOKE
        set_vox(zc_f, 0, cx_n + dx_n, c_f, MAT_METAL, fname)
      set_vox(zc_f, 1, cx_n + dx_n, SPOKE, MAT_BODY, 'chassis')

# 7. Sleek low-profile active rear spoiler (split cleanly to 'spoiler' part)
for side in (-1, 1):
  sx = int(round(CX + side * 7.5))
  for zc in (21, 22):
    for yc in (2, 3, 4):
      set_vox(zc, yc, sx, SKIRT, MAT_BODY, 'chassis')
  ex = int(round(CX + side * 18.5))
  for yc in range(0, 6):
    z_lo = 21 if yc <= 3 else 22
    z_hi = 24 if yc <= 4 else 23
    for zc in range(z_lo, z_hi + 1):
      set_vox(zc, yc, ex, WHITE_FACET if zc == z_hi else WHITE_SIDE, MAT_BODY, 'spoiler')

for x in range(W):
  dx = abs(x - CX)
  if dx <= 17.5:
    for yc in range(0, 7):
      if yc == 6 and dx > 13.0:
        continue
      if yc == 5 and dx > 16.0:
        continue
      zc = 24 if yc <= 3 else 23
      c = WHITE_TOP if (1 <= yc <= 5 and dx <= 16.0) else WHITE_FACET
      set_vox(zc, yc, x, c, MAT_BODY, 'spoiler')

# Underbody brass hover thruster nozzle tips
HOVER_JETS = [
    ('liftRL', 14, CX + 17.0),
    ('liftRR', 14, CX - 17.0),
    ('liftFL', 94, CX + 15.0),
    ('liftFR', 94, CX - 15.0),
]
for _, jy, jx in HOVER_JETS:
  for dx_t in (-1, 0, 1):
    for dy_t in (-1, 0, 1):
      if abs(dx_t) + abs(dy_t) <= 1:
        set_vox(3, jy + dy_t, int(round(jx + dx_t)), NOZZLE_BRONZE, MAT_METAL)
        set_vox(2, jy + dy_t, int(round(jx + dx_t)), NOZZLE_BRONZE, MAT_METAL)
        set_vox(1, jy + dy_t, int(round(jx + dx_t)), SKIRT_TOP if dx_t == 0 and dy_t == 0 else NOZZLE_BRONZE, MAT_METAL)
  set_vox(0, jy, int(round(jx)), NOZZLE_BRONZE, MAT_METAL)

# Surface culling: keep a voxel if any of its 6 neighbors is empty OR belongs to a different part
palette = []
palette_map = {}

def pal_idx(rgb):
  hx = f'#{rgb[0]:02x}{rgb[1]:02x}{rgb[2]:02x}'
  if hx not in palette_map:
    palette_map[hx] = len(palette)
    palette.append(hx)
  return palette_map[hx]

pivots = {
    'chassis': [0.0, 0.0, 0.0],
    'spoiler': [0.0, round(22.5 * VOXEL_SIZE, 4), round((3.0 - 57.5) * VOXEL_SIZE, 4)],
    **wheel_pivots,
    **fan_pivots,
}
parts_out = {name: {'pivot': pivots[name], 'voxels': []} for name in PART_NAMES}

DIRS = ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
total_exposed = 0
for zc in range(H_CAR):
  for yc in range(L_CAR):
    for x in range(W):
      if not occ[zc, yc, x]:
        continue
      pid = int(part_grid[zc, yc, x])
      exposed = False
      for dz, dy, dx in DIRS:
        nz, ny, nx = zc + dz, yc + dy, x + dx
        if not (0 <= nz < H_CAR and 0 <= ny < L_CAR and 0 <= nx < W) or not occ[nz, ny, nx] or int(part_grid[nz, ny, nx]) != pid:
          exposed = True
          break
      if not exposed:
        continue
      pname = PART_NAMES[pid]
      px, py, pz = pivots[pname]
      wx = round((x - CX) * VOXEL_SIZE - px, 4)
      wy = round((zc + 0.5) * VOXEL_SIZE - py, 4)
      wz = round((yc - 57.5) * VOXEL_SIZE - pz, 4)
      cidx = pal_idx(tuple(int(v) for v in col_grid[zc, yc, x]))
      mtag = int(mat_grid[zc, yc, x])
      parts_out[pname]['voxels'].extend([wx, wy, wz, cidx, mtag])
      total_exposed += 1

def to_m(x_grid, y_grid, z_grid):
  return [
      round((x_grid - CX) * VOXEL_SIZE, 4),
      round((z_grid + 0.5) * VOXEL_SIZE, 4),
      round((y_grid - 57.5) * VOXEL_SIZE, 4),
  ]

nozzles = {
    'liftFL': to_m(CX + 15.0, 94, 0),
    'liftFR': to_m(CX - 15.0, 94, 0),
    'liftRL': to_m(CX + 17.0, 14, 0),
    'liftRR': to_m(CX - 17.0, 14, 0),
    'rearBoost': [to_m(cx_n, 0, 10) for cx_n in (15, 22, 29, 36)],
    'retroFront': to_m(CX, 115, 7),
    'rcsLeft': to_m(W - 1, 58, 12),
    'rcsRight': to_m(0, 58, 12),
    'rcsNose': to_m(CX, 113, 12),
    'rcsTail': to_m(CX, 2, 16),
}

out = {
    'voxelSize': VOXEL_SIZE,
    'dimensions': {
        'width': round(W * VOXEL_SIZE, 4),
        'length': round(L_CAR * VOXEL_SIZE, 4),
        'height': round(H_CAR * VOXEL_SIZE, 4),
    },
    'palette': palette,
    'parts': parts_out,
    'nozzles': nozzles,
}

out_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'src', 'assets', 'rostrVoxelData.json')
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with open(out_path, 'w') as f:
  json.dump(out, f, separators=(',', ':'))

print(f'exported {total_exposed} surface voxels across {len(PART_NAMES)} parts -> {out_path} ({os.path.getsize(out_path)} B)')
for pname in PART_NAMES:
  print(f'  {pname}: {len(parts_out[pname]["voxels"]) // 5} voxels, pivot={parts_out[pname]["pivot"]}')

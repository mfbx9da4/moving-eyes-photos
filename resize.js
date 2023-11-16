// These eye measurements were for the size 3266 × 4897 we need to recompute them for the new width of 510
const rawPhotos = [
  {
    url: './Photoshoot/0E9A9000.jpg',
    direction: 'north',
    leftEye: {
      x: 1416.6274999999998,
      y: 1592.1749999999997,
    },
    rightEye: {
      x: 1963.6825,
      y: 1584.0099999999998,
    },
  },
  {
    url: './Photoshoot/0E9A9002.jpg',
    direction: 'north east',
    leftEye: {
      x: 1428.8749999999998,
      y: 1604.4225,
    },
    rightEye: {
      x: 1980.0124999999998,
      y: 1596.2575,
    },
  },
  {
    url: './Photoshoot/0E9A9003.jpg',
    direction: 'north east east',
    leftEye: {
      x: 1514.6074999999998,
      y: 1608.5049999999999,
    },
    rightEye: {
      x: 2069.8275,
      y: 1600.34,
    },
  },
  {
    url: './Photoshoot/0E9A9004.jpg',
    direction: 'east',
    leftEye: {
      x: 1514.6074999999998,
      y: 1649.33,
    },
    rightEye: {
      x: 2069.8275,
      y: 1632.9999999999998,
    },
  },
  {
    url: './Photoshoot/0E9A9005.jpg',
    direction: 'south east east',
    leftEye: {
      x: 1543.185,
      y: 1645.2474999999997,
    },
    rightEye: {
      x: 2102.4874999999997,
      y: 1632.9999999999998,
    },
  },
  {
    url: './Photoshoot/0E9A9006.jpg',
    direction: 'south east',
    leftEye: {
      x: 1481.9474999999998,
      y: 1641.1649999999997,
    },
    rightEye: {
      x: 2049.415,
      y: 1604.4225,
    },
  },
  {
    url: './Photoshoot/0E9A9008.jpg',
    direction: 'south south east',
    leftEye: {
      x: 1494.195,
      y: 1657.495,
    },
    rightEye: {
      x: 2053.4975,
      y: 1641.1649999999997,
    },
  },
  {
    url: './Photoshoot/0E9A9009.jpg',
    direction: 'south',
    leftEye: {
      x: 1510.5249999999999,
      y: 1637.0824999999998,
    },
    rightEye: {
      x: 2102.4874999999997,
      y: 1616.6699999999998,
    },
  },
  {
    url: './Photoshoot/0E9A9012.jpg',
    direction: 'south south west',
    leftEye: {
      x: 1355.3899999999999,
      y: 1665.6599999999999,
    },
    rightEye: {
      x: 1939.1874999999998,
      y: 1649.33,
    },
  },
  {
    url: './Photoshoot/0E9A9013.jpg',
    direction: 'south west',
    leftEye: {
      x: 1371.7199999999998,
      y: 1641.1649999999997,
    },
    rightEye: {
      x: 1963.6825,
      y: 1632.9999999999998,
    },
  },
  {
    url: './Photoshoot/0E9A9015.jpg',
    direction: 'south west west',
    leftEye: {
      x: 1334.9775,
      y: 1608.5049999999999,
    },
    rightEye: {
      x: 1943.2699999999998,
      y: 1600.34,
    },
  },
  {
    url: './Photoshoot/0E9A9017.jpg',
    direction: 'west',
    leftEye: {
      x: 1290.07,
      y: 1616.6699999999998,
    },
    rightEye: {
      x: 1865.7024999999999,
      y: 1592.1749999999997,
    },
  },
  {
    url: './Photoshoot/0E9A9020.jpg',
    direction: 'north west',
    leftEye: {
      x: 1265.5749999999998,
      y: 1632.9999999999998,
    },
    rightEye: {
      x: 1857.5375,
      y: 1596.2575,
    },
  },
  {
    url: './Photoshoot/0E9A9019.jpg',
    direction: 'north north west',
    leftEye: {
      x: 1330.8949999999998,
      y: 1575.8449999999998,
    },
    rightEye: {
      x: 1935.1049999999998,
      y: 1539.1024999999997,
    },
  },
]

const photos = rawPhotos.map((photo) => {
  const ratio = 510 / 3266
  const leftEye = {
    x: photo.leftEye.x * ratio,
    y: photo.leftEye.y * ratio,
  }
  const rightEye = {
    x: photo.rightEye.x * ratio,
    y: photo.rightEye.y * ratio,
  }
  return {
    ...photo,
    leftEye,
    rightEye,
  }
})
copy(photos)

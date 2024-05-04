const earth = 6371e3; //radius of the earth, meters
const edgeSize = 10; //size of edge between two neigbor points, meters
const degrees = 10; //increment in degrees for neighbors

function toRadians(degrees) {
  return degrees * Math.PI / 180;
}

function toDegrees(radians) {
  return radians * 180 / Math.PI;
}

//calculate destination point given distance and bearing from start point
function calculateDestination(lat, lng, bearing, distance) {
  const δ = distance / R; //equivalent to r in polar but angular distance in radians
  const θ = toRadians(bearing);

  //starting point in radians: lat, lng
  const φ1 = toRadians(lat);
  const λ1 = toRadians(lng);

  //spherical law of cosines, etc
  //destination point in radians: lat, lng. used to populate graph - destination is neighbor.
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));

  return [toDegrees(φ2), toDegrees(λ2)];
}

class Graph {
  constructor() {
    this.nodes = new Map(); //store nodes with their lat, lng as key and neighbors as value
  }

  //explore from the given start point
  //intended to populate graph as we go because we won't need all of it
  //save the parts of the graph we construct for future iterations
  //to do: an edge only exists if it is not steep, doesn't turn horizontally too much, and is in the bounds specified
  //using randomized dfs, weight the edges that are forward facing and not steep more. If the front is steep, then it should be encouraged to switchback
  //moving averages should be maintained to ensure it isn't turning too much or climbing/descending too much. If so, terminate that path or backtrack.
  exploreFrom(lat, lng) {
    const key = `${lat},${lng}`;
    if (this.nodes.has(key)) {
      return; //already explored this node
    }

    const neighbors = [];
    for (let angle = 0; angle < 360; angle += degrees) {
      const neighbor = calculateDestination(lat, lng, angle, edgeSize);
      neighbors.push(neighbor);
    }

    this.nodes.set(key, neighbors);

    neighbors.forEach(([neighborLat, neighborLng]) => this.exploreFrom(neighborLat, neighborLng));
  }
}

const graph = new Graph();
const startPoint = [35.0, -80.0]; //start point latitude and longitude

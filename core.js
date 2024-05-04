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
//bearing is the angle measured from due north, clockwise
function calculateDestination(lat, lng, bearing, distance) {
    const δ = distance / earth; //equivalent to r in polar but angular distance in radians
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
        this.queue = []; // queue to manage exploration without recursion
        this.map = map; //maplibregl map object
    }

    //explore from the given start point
    //intended to populate graph as we go because we won't need all of it
    //save the parts of the graph we construct for future iterations
    //to do: moving averages should be maintained to ensure it isn't turning too much or climbing/descending too much over 5-10 edges. If so, terminate that path or backtrack.
    //store where have visited before and escape when reach destination. 
    async exploreFrom(startLat, startLng, endLat, endLng, min_distance_between_trails, bounds) {
        this.queue.push({
            lat: startLat,
            lng: startLng,
            bearing: 0, //tbd
            elevation: await this.getElevation(startLat, startLng),
            slope: 0
        });
        while (this.queue.length > 0) {
            const current = this.queue.shift();
            const key = `${current.lat},${current.lng}`;
            if (this.nodes.has(key) || this.isTooCloseToExistingPath(current.lat, current.lng, min_distance_between_trails)) {
                continue; //already explored this node or if exploring it would get us too close to other trails. 
                //we want this check here as opposed to in the graph creation because in another run, the move might be valid. the second check depends on the path taken; we can't say the edge doesn't exist for all 
            }

            const neighbors = [];
            const currentElevation = current.elevation;
            for (let angle = 0; angle < 360; angle += degrees) {
                const neighbor = calculateDestination(current.lat, current.lng, angle, edgeSize);
                const [neiLat, neiLng] = neighbor;
                const neighborElevation = await this.getElevation(neiLat, neiLng);
                const neighborSlope = this.calculateSlope(currentElevation, neighborElevation, edgeSize);
                if (this.isWithinBounds(neiLat, neiLng, bounds)) {
                    neighbors.push({
                        coordinates: neighbor,
                        bearing: angle,
                        slope: neighborSlope,
                        elevation, neighborElevation,
                        probability: this.calculateProbability(current.lat, current.lng, current.elevation, current.bearing, current.slope, neiLat, neiLng, neighborElevation, angle, neighborSlope)
                    });
                }
            }

            //store neighbors with probabilities
            this.nodes.set(key, neighbors);

            //select the next node to explore based on probability
            const selectedNeighbor = this.weightedRandomSelect(neighbors);
            if (selectedNeighbor) {
                this.queue.push({
                    lat: selectedNeighbor.coordinates[0],
                    lng: selectedNeighbor.coordinates[1],
                    bearing: selectedNeighbor.bearing,
                    elevation: selectedNeighbor.elevation,
                    slope: selectedNeighbor.slope
                });
            }
        }
    }

    async getElevation(lat, lng) {
        return new Promise(resolve => {
            const elevation = this.map.queryTerrainElevation([lng, lat]);
            resolve(elevation);
        });
    }
    
    //as a percent
    calculateSlope(elevation1, elevation2, distance) {
        return ((elevation2 - elevation1) / distance) * 100;
    }


    //function to calculate the probability of selecting an edge
    calculateProbability(lat1, lng1, e1, b1, s1, lat2, lng2, e2, b2, s2) {
        let probability = 1;
    
        if (s2 > 10) probability *= 0.5;
        if (s2 > 20) probability *= 0.1;
        
        if (b1-b2 > 40 || b2-b1 < 40) probability *= 0.5;
    
        return Math.max(0.01, probability);
    }

    //randomly choose a neighbor to visit based on the provided probabilities
    weightedRandomSelect(neighbors) {
        const total = neighbors.reduce((sum, { probability }) => sum + probability, 0);
        let threshold = Math.random() * total; //no more than the sum of all probabilities
        for (let i = 0; i < neighbors.length; i++) {
            threshold -= neighbors[i].probability;
            //bigger probabilities have a higher chance of making this difference be negative. 
            if (threshold <= 0) {
                return neighbors[i];
            }
        }
    }

    isWithinBounds(lat, lng, bounds) {
        return lat >= bounds.minLat && lat <= bounds.maxLat &&
               lng >= bounds.minLng && lng <= bounds.maxLng;
    }

    isTooCloseToExistingPath(lat, lng, minDistance) {
        return false;
    }
}



const graph = new Graph();
const startPoint = [35.0, -80.0];

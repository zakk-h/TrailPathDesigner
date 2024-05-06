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
    constructor(map, geojson) {
        this.nodes = new Map(); //store nodes with their lat, lng as key and neighbors as value
        this.stack = []; // stack to manage exploration without recursion
        this.map = map; //maplibregl map object
        this.geojson = geojson;
    }

    //explore from the given start point
    //intended to populate graph as we go because we won't need all of it
    //save the parts of the graph we construct for future iterations
    //to do: moving averages should be maintained to ensure it isn't turning too much or climbing/descending too much over 5-10 edges. If so, terminate that path or backtrack.
    //store where have visited before and escape when reach destination. 
    async exploreFrom(startLat, startLng, endLat, endLng, min_distance_between_trails, bounds) {
        this.stack.push({
            lat: startLat,
            lng: startLng,
            bearing: 0, //tbd
            elevation: await this.getElevation(startLat, startLng),
            slope: 0
        });

        let count = 1;
        while (this.stack.length > 0) {
            if (count > 500) break;
            console.log("Iteration " + count);
            const current = this.stack.pop();
            if (current == null) continue;
            const key = `${current.lat},${current.lng}`;
            if (this.nodes.has(key) || this.isTooCloseToExistingPath(current.lat, current.lng, min_distance_between_trails)) { 
                console.log("Too close, skipping");
                //current issue because the implementation will say it is too close because the last point will always be less than the min distance. we need to exclude the last min_distance/edge_size additions.
                continue; //already explored this node or if exploring it would get us too close to other trails. 
                //we want this check here as opposed to in the graph creation because in another run, the move might be valid. the second check depends on the path taken; we can't say the edge doesn't exist for all 
            }
            console.log('Adding point to map:', { lat: current.lat, lng: current.lng });
            this.addPointToMap(current.lat, current.lng); //display where we are exploring

            const neighbors = [];
            const currentElevation = current.elevation;
            for (let angle = 0; angle < 360; angle += degrees) {
                const neighbor_coords = calculateDestination(current.lat, current.lng, angle, edgeSize);
                const [neiLat, neiLng] = neighbor_coords;
                const neighborElevation = await this.getElevation(neiLat, neiLng);
                const neighborSlope = this.calculateSlope(currentElevation, neighborElevation, edgeSize);
                if (this.isWithinBounds(neiLat, neiLng, bounds)) {
                    neighbors.push({
                        lat: neiLat,
                        lng: neiLng,
                        bearing: angle,
                        slope: neighborSlope,
                        elevation: neighborElevation,
                        probability: this.calculateProbability(current.lat, current.lng, current.elevation, current.bearing, current.slope, neiLat, neiLng, neighborElevation, angle, neighborSlope)
                    });
                }
            }

            //store neighbors with probabilities
            this.nodes.set(key, neighbors);

            //select the next node to explore based on probability
            const selectedNeighborIndex = this.weightedRandomSelect(neighbors);
            const selectedNeighbor = neighbors.splice(selectedNeighborIndex, 1)[0]; //remove the selected neighbor

            //randomly shuffle the neighbors so that when we add them all to the stack, beyond the first favorite element, it is random which comes out next.
            this.shuffleArray(neighbors);

            neighbors.forEach(neighbor => { //looping through each element of neighbors and adding to stack
                this.stack.push(neighbor); //everything that isn't our neighbor to explore first can get piled at the back. 
            });
  
            this.stack.push(selectedNeighbor); //push the selected last to be processed first. it is our "favorite"

            count++; //temp to prevent infinite loop
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
        
        if (Math.abs(b1 - b2) > 40) probability *= 0.5;
    
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
                return i;
            }
        }
    }

    addPointToMap(lat, lng) {
        const point = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [lng, lat]
            },
            properties: {}
        };

        this.geojson.features.push(point);

        if (this.map.getSource('geojson')) {
            this.map.getSource('geojson').setData(this.geojson);
            console.log('Point added:', { lat, lng });
        } else {
            console.error('Source not yet available.');
        }
    }

    calculateDistance(lat1, lng1, lat2, lng2) {
        const R = 6371e3; //earth radius (meters)
        const φ1 = toRadians(lat1);
        const φ2 = toRadians(lat2);
        const Δφ = toRadians(lat2 - lat1);
        const Δλ = toRadians(lng2 - lng1);

        const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
            Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

        return (R * c); //nonnegative
    }

    isWithinBounds(lat, lng, bounds) {
        return lat >= bounds.minLat && lat <= bounds.maxLat &&
               lng >= bounds.minLng && lng <= bounds.maxLng;
    }

    isTooCloseToExistingPath(lat, lng, minDistance) {
        //java maps preserve order of insertion. we need to split the check into two sections.
        //we can't just check if the proposed new point is within the distance of all the current points in the trail
        //because the edge distance is likely less than the minimum distance, and it would say we can't add a new point because 
        //the proposed point is too close to the last point. so we need to cut off those last points.
        //but we still need to check the last points to make sure the algorithm is not backtracking.
        //we check that the distance from the current point to the one before is no more than the size of an edge, for two away, no more than two times the size of the edge......
        //and so on, for that section. the ceiling may be being overly safe but is a small computational expense for the guarentee while this algorithm is in testing. that particular choice (instead of a floor) can be revisited.
        const adjustmentFactor = 1.7;
        const skipLastNPoints = Math.ceil((minDistance / edgeSize) * adjustmentFactor);
        const turningFactor = 0.9;

        const allKeys = Array.from(this.nodes.keys());
        const totalKeys = allKeys.length;

        if (totalKeys === 0) {
            return false; //no nodes yet, so it's never too close to an existing path
        }

        //determine the starting point for proximity checks
        const limit = Math.max(0, totalKeys - skipLastNPoints);
        let nodeCount = 0;

        for (let i = 0; i < limit; i++) {
            const [nodeLat, nodeLng] = allKeys[i].split(',').map(Number);
            if (this.calculateDistance(lat, lng, nodeLat, nodeLng) < minDistance) {
                return true;
            }
        }

        for (let i = totalKeys - 1; i >= limit; i--) {
            nodeCount++;
            const [nodeLat, nodeLng] = allKeys[i].split(',').map(Number);
            if (this.calculateDistance(lat, lng, nodeLat, nodeLng) < nodeCount * edgeSize * turningFactor) {
                return true;
            }
        }

        return false;
    }
    

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]]; //swap
        }
    }
}

async function main() {
    const map = new maplibregl.Map({
        container: "map",
        zoom: 15,
        center: [-81.55219, 35.77098],
        pitch: 45,
        maxPitch: 70,
        minZoom: 9,
        style: {
            version: 8,
            name: "Trail Designer GeoPortal",
            sources: {
                osm: {
                    type: "raster",
                    tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"],
                    tileSize: 256,
                    attribution: "&copy; OpenStreetMap Contributors",
                    maxzoom: 19
                },
                hillshade_source: {
                    type: "raster-dem",
                    encoding: "terrarium",
                    tiles: [
                        "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
                    ],
                    tileSize: 256,
                    minzoom: 0,
                    maxzoom: 14
                },
                terrain_source: {
                    type: "raster-dem",
                    encoding: "terrarium",
                    tiles: [
                        "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
                    ],
                    tileSize: 256,
                    minzoom: 0,
                    maxzoom: 14
                }
            },
            layers: [
                { id: "osm", type: "raster", source: "osm" },
                { id: "hills", type: "hillshade", source: "hillshade_source" }
            ],
            terrain: { source: 'terrain_source', exaggeration: 5 }
        }
    });

    const geojson = {
        type: "FeatureCollection",
        features: []
    };

    map.on("load", async () => {
        map.addSource('geojson', {
            type: 'geojson',
            data: geojson
        });

        map.addLayer({
            id: 'measure-points',
            type: 'circle',
            source: 'geojson',
            paint: {
                'circle-radius': 5,
                'circle-color': '#007cbf'
            }
        });

        const graph = new Graph(map, geojson);
        const startPoint = [35.77098, -81.55219];
        const endLat = 35.0;
        const endLng = -80.0;
        const min_distance_between_trails = 50;
        const bounds = { minLat: 35, maxLat: 36, minLng: -82, maxLng: -81 };

        await graph.exploreFrom(startPoint[0], startPoint[1], endLat, endLng, min_distance_between_trails, bounds);
    });
}

main();


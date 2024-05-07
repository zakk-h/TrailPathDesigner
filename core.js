const earth = 6371e3; //radius of the earth, meters
const edgeSize = 10; //size of edge between two neigbor points, meters
const degrees = 5; //increment in degrees for neighbors
const movingAvgPeriod = 10;

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
    constructor(map, geojson, enablePlotting = true) {
        this.nodes = new Map(); //store nodes with their lat, lng as key and neighbors as value
        this.stack = []; // stack to manage exploration without recursion
        this.map = map; //maplibregl map object
        this.geojson = geojson;
        this.success = false;
        this.trail = [];
        this.enablePlotting = enablePlotting;
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
            slope: 0,
            costHistory: [0]
        });
        this.trail = [];
        let count = 1;
        while (this.stack.length > 0) {
            if (count > 1000) break;
            console.log("Iteration " + count);
            const current = this.stack.pop();
            if (current == null) continue;
            if (this.calculateDistance(current.lat, current.lng, endLat, endLng) < 20) {
                this.success = true;
                this.trail.push(current);
                console.log("Made it!");
                break;
            }
            const key = `${current.lat},${current.lng}`;
            if (this.nodes.has(key) || this.isTooCloseToExistingPath(current.lat, current.lng, min_distance_between_trails)) { 
                console.log("Too close, skipping");
                //current issue because the implementation will say it is too close because the last point will always be less than the min distance. we need to exclude the last min_distance/edge_size additions.
                continue; //already explored this node or if exploring it would get us too close to other trails. 
                //we want this check here as opposed to in the graph creation because in another run, the move might be valid. the second check depends on the path taken; we can't say the edge doesn't exist for all 
            }
            console.log('Adding point to map:', { lat: current.lat, lng: current.lng });
            if (this.enablePlotting) {
                this.addPointToMap(current.lat, current.lng); //display where we are exploring
            } 
            this.trail.push(current);

            const neighbors = [];
            const currentElevation = current.elevation;
            for (let angle = 0; angle < 360; angle += degrees) {
                const neighbor_coords = calculateDestination(current.lat, current.lng, angle, edgeSize);
                const [neiLat, neiLng] = neighbor_coords;
                const neighborElevation = await this.getElevation(neiLat, neiLng);
                const neighborSlope = this.calculateSlope(currentElevation, neighborElevation, edgeSize);
                if (this.isWithinBounds(neiLat, neiLng, bounds)) {
                    let sign = neighborSlope < 0 ? -1 : 1;
                    const edgeCost = 2 ** Math.abs(neighborSlope); 
                    neighbors.push({
                        lat: neiLat,
                        lng: neiLng,
                        bearing: angle,
                        slope: neighborSlope,
                        elevation: neighborElevation,
                        probability: this.calculateProbability(current.lat, current.lng, current.elevation, current.bearing, current.slope, neiLat, neiLng, neighborElevation, angle, neighborSlope, endLat, endLng),
                        costHistory: [...current.costHistory, edgeCost]
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
            /*
            if (this.shouldBacktrack(current.costHistory, movingAvgPeriod)) {
                console.log("Backtracking");
                this.colorBacktrackedPoint(current.lat, current.lng); //mark backtracked point yellow
                this.nodes.delete(key); //remove point from the graph
                continue; //perform backtracking by skipping
            }
            */
  
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
    calculateProbability(lat1, lng1, e1, b1, s1, lat2, lng2, e2, b2, s2, endLat, endLng) {
        let probability = 1;

        s1 = Math.abs(s1);
        s2 = Math.abs(s2);
    
        //adjust slope-based probability
        if (s2 > 30) probability *= 0.00005;
        else if (s2 > 20) probability *= 0.0005;
        else if (s2 > 10) probability *= 0.05;
        else if (s2 > 8) probability *= 0.5;
        else if (s2 > 5) probability *= 0.6;
        else if (s2 < 5 && s2 > 1) probability *= 2**s2;
        else probability *= 5;
    
        //adjust turn angle-based probability
        // Calculate bearing from the new point to the endpoint
        const bearingToEnd = this.calculateBearing(lat2, lng2, endLat, endLng);
        const directionDiffToEnd = Math.abs(((bearingToEnd - b2 + 180) % 360) - 180);

        //apply a bias towards the endpoint direction
        const maxAngleBias = 90; //maximum angle deviation towards the endpoint
        const halfMaxAngleBias = maxAngleBias/2
        if (directionDiffToEnd < halfMaxAngleBias) {
            const directionBias = (maxAngleBias - directionDiffToEnd) / halfMaxAngleBias;
            probability *= 1 + 2*Math.abs(directionBias); // Increase weight
        } else if (directionDiffToEnd < maxAngleBias){
            probability *= 0.35 //partial penalty
        } else if (directionDiffToEnd < maxAngleBias+halfMaxAngleBias) {
            probability *= 0.2
        }
        else {
            probability *= 0.001; //penalize paths too far from the endpoint direction
        }
    
        //increase bias towards the endpoint as we get closer
        const distanceToEnd1 = this.calculateDistance(lat1, lng1, endLat, endLng);
        const distanceToEnd2 = this.calculateDistance(lat2, lng2, endLat, endLng);
        const t1 = 500; //assume 70 m is a good range to start steering strongly
        const t2 = 100;
        const t3 = 50;
        const t4 = 25;
        let strongFactor = 1;
        if (distanceToEnd2 < t1) strongFactor = 4;
        else if (distanceToEnd2 < t2) strongFactor = 16;
        else if (distanceToEnd2 < t3) strongFactor = 256;
        else if (distanceToEnd2 < t4) strongFactor = 1024;
        let improvement = false;
        let muchImprovement = false
        const diff = distanceToEnd2-distanceToEnd1;
        if ((diff) < -2) improvement = true; //improvement false means less than 2 unit progress in size 10 edge
        if ((diff < -5)) muchImprovement = true;
        if (improvement) probability*=strongFactor*Math.abs(diff/8+1);
        else {
            probability*= 1/(strongFactor*Math.abs(diff/8+1));
        }
        if (muchImprovement) probability*=4
    
        return Math.max(0.01, probability); //ensure a minimum probability in case something happens
    }
    
    calculateBearing(lat1, lng1, lat2, lng2) {
        const φ1 = toRadians(lat1);
        const φ2 = toRadians(lat2);
        const Δλ = toRadians(lng2 - lng1);
    
        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    
        return (toDegrees(Math.atan2(y, x)) + 360) % 360; //normalize to 0-360 degrees
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

    /*
    shouldBacktrack(costHistory, period) {
        if (costHistory.length < period) return false;
    
        //sum the last `period` many elements
        const recentSum = costHistory.slice(-period).reduce((a, b) => a + b, 0);
    
        return recentSum > (32) * period; //each cost can be no more than 32 on average
    }

    colorBacktrackedPoint(lat, lng) {
        const point = {
            type: 'Feature',
            geometry: {
                type: 'Point',
                coordinates: [lng, lat]
            },
            properties: {
                'circle-color': '#FFEB3B' //yellow color for backtracked points
            }
        };
    
        this.geojson.features.push(point);
    
        if (this.map.getSource('geojson')) {
            this.map.getSource('geojson').setData(this.geojson);
            console.log('Backtracked point marked:', { lat, lng });
        } else {
            console.error('Source not yet available.');
        }
    }
    */

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
        const skipLastNPoints = Math.ceil((minDistance / edgeSize) * adjustmentFactor+2);
        const turningFactor = 0.7;

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
    
    evaluateTrail() {
        if (!this.success) return -1;
        if (this.trail.length < 2) return -1;

        let totalSlope = 0;
        for (let i = 1; i < this.trail.length; i++) {
            totalSlope += Math.abs(this.trail[i].slope);
        }

        return totalSlope / (this.trail.length - 1); //judging a trail by its average slope
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]]; //swap
        }
    }
}

async function main() {
    const startPoint = [35.75648779699748, -81.74786525650568];
    const endPoint = [35.774223418422906, -81.75507496467101];
    
    const map = new maplibregl.Map({
        container: "map",
        zoom: 15,
        center: [startPoint[1], startPoint[0]],
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
        const endLat = endPoint[0];
        const endLng = endPoint[1];
        const min_distance_between_trails = 50;
        const point1 = [35.75255431417668, -81.74284623221929];
        const point2 = [35.75245458243691, -81.76119789811102];
        const point3 = [35.77691821314957, -81.75652044196116];
        const point4 = [35.76644529555712, -81.74622554695067]; 
        const bounds = { minLat: Math.min(point1[0], point2[0], point3[0], point4[0]), maxLat: Math.max(point1[0], point2[0], point3[0], point4[0]), minLng: Math.min(point1[1], point2[1], point3[1], point4[1]), maxLng: Math.max(point1[1], point2[1], point3[1], point4[1]) };

        await graph.exploreFrom(startPoint[0], startPoint[1], endLat, endLng, min_distance_between_trails, bounds);
    });
}

main();
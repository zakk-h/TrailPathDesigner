const earth = 6371e3; //radius of the earth, meters
const edgeSize = 35; //size of edge between two neigbor points, meters
const degrees = 1; //increment in degrees for neighbors
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
    //to do:currently, we are populating the adjacency lists as we go because we will not hit the vast majority of points.
    //with our loop structure, instead of making a new graph each time, we should keep adding to the previous adjacency lists
    async exploreFrom(startLat, startLng, endLat, endLng, min_distance_between_trails, bounds) {
        this.stack.push({
            lat: startLat,
            lng: startLng,
            bearing: 0, //tbd
            elevation: await this.getElevation(startLat, startLng),
            slope: 0,
            //costHistory: [0]
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
                        //costHistory: [...current.costHistory, edgeCost]
                    });
                } else {
                    console.log("Out of bounds point proposed");
                }
            }

            //store neighbors with probabilities
            this.nodes.set(key, neighbors);

            //select the next node to explore based on probability
            const selectedNeighborIndex = this.weightedRandomSelect(neighbors);
            const selectedNeighbor = neighbors.splice(selectedNeighborIndex, 1)[0]; //remove the selected neighbor

            //randomly shuffle the neighbors so that when we add them all to the stack, beyond the first favorite element, it is random which comes out next.
            this.shuffleArray(neighbors);

            //clears stack
            //once we have moved on to the next node successfully (in bounds, not too close to another trail), we've committed to this path, so we don't need anything else in the stack.
            this.stack.length = 0;

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

        const latDiff = lat2-lat1;
        const lngDiff = lng2-lng1;

        //adjust slope-based probability
        let baseProbability;

        if (s2 > 30) {
            probability = 0;
            baseProbability = 0.0000000000000005;
        } else if (s2 > 20) {
            probability = 0;
            baseProbability = 0.000000000005;
        } else if (s2 > 10) {
            baseProbability = 0.0000000005;
        } else if (s2 > 8) {
            baseProbability = 0.5;
        } else if (s2 > 5) {
            baseProbability = 0.6;
        } else if (s2 > 1) {
            baseProbability = 200;
        } else if (s2 > 0.0) {
            baseProbability = 500;
        } else {
            baseProbability = 1;
        }

        const decayFactor = Math.exp(-0.2 * s2);

        const finalProbability = baseProbability * decayFactor;
    
        probability *= Math.max(finalProbability, Number.EPSILON);    
        /*
        if (s2 > 30) probability *= 0.000005;
        else if (s2 > 20) probability *= 0.00005;
        else if (s2 > 10) probability *= 0.005;
        else if (s2 > 8) probability *= 0.5;
        else if (s2 > 5) probability *= 0.6;
        else if (s2 < 5 && s2 > 1) probability *= 2 ** s2;
        else if (s2 > 0.2) probability *= 5;
        */

        //adjust turn angle-based probability
        //calculate bearing from the new point to the endpoint
        const bearingToEnd = this.calculateBearing(lat2, lng2, endLat, endLng);
        const directionDiffToEnd = Math.abs(((bearingToEnd - b2 + 180) % 360) - 180);

        //apply a bias towards the endpoint direction
        const maxAngleBias = 90; //maximum angle deviation towards the endpoint
        const halfMaxAngleBias = maxAngleBias / 2
        if (directionDiffToEnd < halfMaxAngleBias) {
            const directionBias = (maxAngleBias - directionDiffToEnd) / halfMaxAngleBias;
            probability *= 1 + 2 * Math.abs(directionBias); // Increase weight
        } else if (directionDiffToEnd < maxAngleBias) {
            probability *= 0.35 //partial penalty
        } else if (directionDiffToEnd < maxAngleBias + halfMaxAngleBias) {
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
        const diff = distanceToEnd2 - distanceToEnd1;
        if ((diff) < -2) improvement = true; //improvement false means less than 2 unit progress in size 10 edge
        if ((diff < -5)) muchImprovement = true;
        if (improvement) probability *= strongFactor * Math.abs(diff / 8 + 1);
        else {
            probability *= 1 / (strongFactor * Math.abs(diff / 8 + 1));
        }
        if (muchImprovement) probability *= 4



        //looking into the future
        /*
        const mult = 5;
        
        let baseProbability2;
        let futureSlope;
        let decayFactor2;
        let finalProbability2;

        let thereExistsNotSteepSlope = false;
        //if we find one in the loops that is <2 percent, make true, and insanely increase probability. Otherwise, insanely decrease.
        //check 360 degrees around, not just what I'm doing here.
        for (let i = mult; i < mult+0.1; i+=0.5) { //make loop be 270 forward degrees or 180 forward degrees. or something.
            futureSlope = Math.abs(this.calculateSlope(e2, this.getElevation(lat2+i*latDiff, lng2+lngDiff), this.calculateDistance(lat2+latDiff, lng2+i*lngDiff, lat2, lng2)));
            if (futureSlope < 2) thereExistsNotSteepSlope = true;
        }
        for (let i = 0; i < mult; i+=0.5) { //make loop be 270 forward degrees or 180 forward degrees. or something.
            futureSlope = Math.abs(this.calculateSlope(e2, this.getElevation(lat2+latDiff, lng2+i*lngDiff), this.calculateDistance(lat2+latDiff, lng2+i*lngDiff, lat2, lng2)));
            if (futureSlope < 2) thereExistsNotSteepSlope = true;
        }

        if(thereExistsNotSteepSlope) probability*=5;
        else probability *= 0.2;
        */




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
        const skipLastNPoints = Math.ceil((minDistance / edgeSize) * adjustmentFactor + 2);
        const turningFactor = 0.7;

        //const allKeys = Array.from(this.nodes.keys());

        if (this.trail.length === 0) {
            return false; //no nodes yet, so it's never too close to an existing path
        }

        const totalTrailPoints = this.trail.length;

        //determine the starting point for proximity checks
        const limit = Math.max(0, totalTrailPoints - skipLastNPoints);
        let nodeCount = 0;

        for (let i = 0; i < limit; i++) {
            const trailPoint = this.trail[i];
            if (this.calculateDistance(lat, lng, trailPoint.lat, trailPoint.lng) < minDistance) {
                return true;
            }
        }

        for (let i = totalTrailPoints - 1; i >= limit; i--) {
            nodeCount++;
            const trailPoint = this.trail[i];
            if (this.calculateDistance(lat, lng, trailPoint.lat, trailPoint.lng) < nodeCount * edgeSize * turningFactor) {
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

        //extra details on mileage for the user to observe
        console.log(`Trail Miles: ${this.getMiles().toFixed(2)} miles`);

        return (totalSlope - this.trail.length) / (this.trail.length - 1); //judging a trail by its average slope
    }

    getMiles() {
        const totalEdges = this.trail.length - 1;
        const totalDistanceMeters = totalEdges * edgeSize;
        const totalDistanceMiles = totalDistanceMeters / 1609.34; //convert meters to miles
        return totalDistanceMiles;
    }

    shuffleArray(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]]; //swap
        }
    }
}

async function main_looped() {
    const startPoint = [35.7152227111945, -81.57114537337591];
    const endPoint = [35.702338722644086, -81.54465706883973];
    const min_distance_between_trails = 33;
    const point1 = [35.698244589645675, -81.58570200251987];
    const point2 = [35.701060248003714, -81.54029022748051];
    const point3 = [35.71653409757802, -81.5447539373979];
    const point4 = [35.717823449438264, -81.5714074363402];
    const bounds = { minLat: Math.min(point1[0], point2[0], point3[0], point4[0]), maxLat: Math.max(point1[0], point2[0], point3[0], point4[0]), minLng: Math.min(point1[1], point2[1], point3[1], point4[1]), maxLng: Math.max(point1[1], point2[1], point3[1], point4[1]) }; const n = 10;

    const map = new maplibregl.Map({
        container: "map",
        zoom: 15,
        center: [(startPoint[1] + endPoint[1]) / 2, (startPoint[0] + endPoint[0]) / 2],
        pitch: 45,
        maxPitch: 70,
        minZoom: 9,
        style: {
            version: 8,
            name: "Trail Designer GeoPortal by zakk-h",
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
            id: 'measure-line',
            type: 'line',
            source: 'geojson',
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': '#FF5733',
                'line-width': 5
            }
        });

        let bestTrailScore = Infinity;
        let bestTrailGeoJson = [];
        let correspondingMiles = 0;

        //to do: (need to make changes in class to make this change work)
        //graph initialization outside to reuse and expand constructed adjacency list
        //it is constructed as we go, likely never completed in full, but keeps growing
        let i = 0;
        while (true) {
            const graph = new Graph(map, geojson, false);
            console.log(`Running trail-finding attempt ${i + 1}/...`);
            const endLat = endPoint[0];
            const endLng = endPoint[1];
            await graph.exploreFrom(startPoint[0], startPoint[1], endLat, endLng, min_distance_between_trails, bounds);

            const trailScore = graph.evaluateTrail();
            console.log(`Trail Score ${i + 1}: ${trailScore}`);

            if (trailScore > 0 && trailScore < bestTrailScore) {
                bestTrailScore = trailScore;
                correspondingMiles = graph.getMiles();
                bestTrailGeoJson = [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: graph.trail.map(point => [point.lng, point.lat])
                        },
                        properties: {}
                    },
                    ...graph.trail.map(point => ({
                        type: 'Feature',
                        geometry: {
                            type: 'Point',
                            coordinates: [point.lng, point.lat]
                        },
                        properties: {}
                    }))
                ];
            }
            if (i > 8 && ((bestTrailScore > 0 && bestTrailScore) < 1000 || i > 35)) break;
            i++;
        }

        geojson.features = bestTrailGeoJson;
        map.getSource('geojson').setData(geojson);

        if (bestTrailGeoJson.length > 0) {
            console.log(`Best Trail Score: ${bestTrailScore}`);
            console.log(`Miles: ${correspondingMiles}`);
        } else {
            console.log("No valid trail found.");
        }
    });
}

main_looped();
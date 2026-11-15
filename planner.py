"""ARES V6: original A* route planner, executed in the browser using Pyodide.
Based on user-supplied app.py, without its HTTP server or downloading threads.
All route metrics are conceptual and never rover-navigation certification.
"""
import math, json, heapq
RADIUS_KM=3396.0
MOVES=((-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1))

DEFAULTS = {'speed':2.0,'mass':900.0,'power':100.0,'efficiency':0.6,'rolling':0.08,'maxSlope':25.0,'hoursPerSol':6.0}
LIMITS = {'speed':(.01,20),'mass':(50,10000),'power':(0,5000),'efficiency':(.1,1),'rolling':(.01,.5),'maxSlope':(1,35),'hoursPerSol':(.1,24.6)}

def settings(data):
    if not isinstance(data,dict): raise ValueError('Rover settings must be an object.')
    out = {}
    for k,default in DEFAULTS.items():
        value=data.get(k,default)
        if isinstance(value,bool): raise ValueError('Invalid '+k)
        try: value=float(value)
        except (TypeError,ValueError): raise ValueError('Invalid '+k)
        lo,hi=LIMITS[k]
        if not math.isfinite(value) or not lo<=value<=hi: raise ValueError(f'{k} must be between {lo} and {hi}.')
        out[k]=value
    return out

def point(value):
    if not isinstance(value,list) or len(value)!=2: raise ValueError('Points must be [column, row] grid indices.')
    if any(isinstance(v,bool) or not isinstance(v,int) or not 0<=v<N for v in value): raise ValueError('Pin is outside the study area.')
    return value[1]*N+value[0]

def horizontal(i,j):
    r,c=divmod(i,N); rr,cc=divmod(j,N)
    # Equirectangular distance at edge mean latitude; sub-km edges in this region.
    return math.hypot((cc-c)*(DX[r]+DX[rr])/2,(rr-r)*DY)

def edge_parts(i,j):
    """Follow the same piecewise-planar triangles as the displayed DEM mesh."""
    r,c=divmod(i,N);rr,cc=divmod(j,N);h=horizontal(i,j)
    if (rr-r)*(cc-c)>0:
        middle=(Z[r*N+cc]+Z[rr*N+c])/2
        return [(h/2,Z[i],middle,[(c+cc)/2,(r+rr)/2]),(h/2,middle,Z[j],[cc,rr])]
    return [(h,Z[i],Z[j],[cc,rr])]

def edge(i,j,p):
    length=hours=wh=risk=grade=0.0
    rough=(ROUGH[i]+ROUGH[j])/2
    for h,z0,z1,_ in edge_parts(i,j):
        dz=z1-z0
        segment=math.hypot(h,dz/1000)
        g=abs(math.degrees(math.atan2(dz,h*1000)))
        speed=p['speed']/(1+(g/10)**2+0.35*rough)
        t=segment/speed
        energy=(p['mass']*3.71*(p['rolling']*segment*1000+max(0,dz)))/(3600*p['efficiency'])+p['power']*t
        length+=segment;hours+=t;wh+=energy;grade=max(grade,g)
        risk+=segment*(1+5*(max(SLOPE[i],SLOPE[j])/10)**2+2*rough)
    return length,hours,wh,risk,grade

def astar(start,end,mode,p,use_heuristic=True):
    cap=min(p['maxSlope'],15.0) if mode=='safety' else p['maxSlope']
    if max(SLOPE[start],SLOPE[end])>cap:
        return {'mode':mode,'available':False,'reason':f'A pin exceeds the {cap:g}° local slope limit. Move it onto gentler terrain.','limit':cap}
    er,ec=divmod(end,N)
    factor={'speed':1/p['speed'],'energy':p['mass']*3.71*p['rolling']*1000/(3600*p['efficiency']),'safety':1}[mode]
    dxmin=min(DX)
    def heuristic(i):
        r,c=divmod(i,N)
        return math.hypot((c-ec)*dxmin,(r-er)*DY)*factor if use_heuristic else 0.0
    costs={start:0.0}; parents={}; queue=[(heuristic(start),0.0,start)]; expanded=0
    while queue:
        _,cost,i=heapq.heappop(queue)
        if cost>costs.get(i,math.inf): continue
        if i==end:
            path=[i]
            while i!=start: i=parents[i];path.append(i)
            path.reverse()
            return summarize(path,mode,p,cap,cost,expanded)
        expanded+=1
        r,c=divmod(i,N)
        for dr,dc in MOVES:
            rr,cc=r+dr,c+dc
            if not (0<=rr<N and 0<=cc<N):continue
            j=rr*N+cc
            if SLOPE[j]>cap:continue
            if dr and dc and (SLOPE[r*N+cc]>cap or SLOPE[rr*N+c]>cap):continue
            length,hours,wh,risk,grade=edge(i,j,p)
            if grade>cap:continue
            weight={'speed':hours,'energy':wh,'safety':risk}[mode]
            new=cost+weight
            if new+1e-12<costs.get(j,math.inf):
                costs[j]=new;parents[j]=i
                heapq.heappush(queue,(new+heuristic(j),new,j))
    return {'mode':mode,'available':False,'reason':f'No connected path satisfies the {cap:g}° limit inside this study area.','limit':cap,'expanded':expanded}

def summarize(path,mode,p,cap,cost,expanded):
    distance=hours=wh=ascent=descent=maxgrade=risk=0.0
    profile=[[0,Z[path[0]]]]
    display_path=[[path[0]%N,path[0]//N]]
    for i,j in zip(path,path[1:]):
        length,t,e,score,grade=edge(i,j,p)
        hours+=t;wh+=e;risk+=score;maxgrade=max(maxgrade,grade)
        for h,z0,z1,coordinate in edge_parts(i,j):
            distance+=math.hypot(h,(z1-z0)/1000)
            ascent+=max(0,z1-z0);descent+=max(0,z0-z1)
            profile.append([round(distance,4),z1]);display_path.append(coordinate)
    result = {'mode':mode,'available':True,'path':display_path,'gridPath':[[i%N,i//N] for i in path],
            'km':distance,'hours':hours,'sols':hours/p['hoursPerSol'],'kwh':wh/1000,
            'ascent':ascent,'descent':descent,'maxGrade':maxgrade,'maxSlope':max(SLOPE[i] for i in path),
            'riskPerKm':risk/max(distance,1e-9),'profile':profile,'limit':cap,'objectiveCost':cost,'expanded':expanded}
    result['directions']=make_directions(result)
    return result

def signed_turn(a,b):
    """Clockwise bearing difference: positive right, negative left."""
    return (b-a+180)%360-180

def turn_description(angle):
    magnitude=abs(angle)
    if magnitude<10:return 'Continue straight'
    side='right' if angle>0 else 'left'
    if magnitude<60:return 'Soft '+side+' turn'
    if magnitude<120:return 'Turn '+side
    if magnitude<165:return 'Sharp '+side+' turn'
    return 'U-turn '+side

def path_heading(a,b):
    lat=METADATA['north']-(a[1]+b[1])/2*METADATA.get('stepLat',METADATA['step'])
    east=(b[0]-a[0])*RADIUS_KM*math.radians(METADATA.get('stepLon',METADATA['step']))*math.cos(math.radians(lat))
    north=(a[1]-b[1])*DY
    return math.degrees(math.atan2(east,north))%360

def make_directions(route):
    """Lossless grouping of consecutive collinear grid edges; no shortcuts.

    Each leg gives the heading to hold, its distance and elevation range, then
    the upcoming turn AT THE END of that leg. Triangle midpoint samples remain
    in the path/profile. The final arrival entry has zero length and no turn.
    """
    path,profile=route['path'],route['profile']
    if len(path)<2:return []
    headings=[path_heading(a,b) for a,b in zip(path,path[1:])]
    starts=[0]
    for i in range(1,len(headings)):
        if abs(signed_turn(headings[i-1],headings[i]))>=10:starts.append(i)
    ends=starts[1:]+[len(path)-1]
    names=('north','northeast','east','southeast','south','southwest','west','northwest')
    legs=[]
    for index,(a,b) in enumerate(zip(starts,ends)):
        bearing=path_heading(path[a],path[b]);last=b==len(path)-1
        upcoming=None if last else signed_turn(headings[b-1],headings[b])
        e0,e1=profile[a][1],profile[b][1]
        cumulative=route['km'] if last else profile[b][0]
        distance=cumulative-profile[a][0]
        direction=names[int((bearing+22.5)//45)%8]
        legs.append({'number':index+1,'heading':round(bearing,2),'cardinal':direction,
                     'title':'Head '+direction,'distanceKm':distance,'startKm':profile[a][0],
                     'endKm':cumulative,'elevationStart':e0,'elevationEnd':e1,'elevationChange':e1-e0,
                     'turnAngle':None if upcoming is None else round(upcoming,2),
                     'turnDescription':'Arrive at destination' if last else turn_description(upcoming),
                     'startIndex':a,'endIndex':b,'target':path[b],'arrival':False})
    legs.append({'number':len(legs)+1,'heading':round(headings[-1],2),'cardinal':names[int((headings[-1]+22.5)//45)%8],
                 'title':'Destination reached','distanceKm':0,'startKm':route['km'],'endKm':route['km'],
                 'elevationStart':profile[-1][1],'elevationEnd':profile[-1][1],'elevationChange':0,
                 'turnAngle':None,'turnDescription':'Stop at destination','startIndex':len(path)-1,
                 'endIndex':len(path)-1,'target':path[-1],'arrival':True})
    return legs


# All values arrive from local, verified NASA datasets via the browser data layer.
def install_region(payload):
    global METADATA,N,Z,LAT,DX,DY,WIDTH,HEIGHT,SLOPE,ROUGH
    data=json.loads(payload)
    METADATA=data['meta'];N=METADATA['n']
    Z=data['heights'];SLOPE=data['slopes'];ROUGH=data['roughness']
    DY=RADIUS_KM*math.radians(METADATA.get('stepLat',METADATA['step']))
    LAT=[METADATA['north']-i*METADATA.get('stepLat',METADATA['step']) for i in range(N)]
    DX=[max(1e-6,RADIUS_KM*math.radians(METADATA.get('stepLon',METADATA['step']))*abs(math.cos(math.radians(lat)))) for lat in LAT]
    WIDTH=METADATA['width'];HEIGHT=METADATA['height']
    return N

def calculate_routes(payload):
    data=json.loads(payload)
    p=settings(data.get('settings',{}))
    a=point(data['start']);b=point(data['end'])
    if a==b:raise ValueError('Starting point and destination are the same cell.')
    routes=[astar(a,b,mode,p) for mode in ('speed','energy','safety')]
    return json.dumps({'routes':routes},separators=(',',':'),allow_nan=False)

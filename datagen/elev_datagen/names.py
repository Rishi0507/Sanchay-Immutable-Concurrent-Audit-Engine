"""Name, place and item pools for the synthetic manufacturer."""

PREFIXES = [
    "Sahyadri", "Godavari", "Krishna", "Narmada", "Shivam", "Omkar", "Siddhivinayak", "Laxmi", "Tulsi", "Vardhman",
    "Surya", "Chandra", "Akshar", "Mahalaxmi", "Prabhat", "Ujwal", "Shakti", "Pragati", "Navkar", "Jai Bharat",
    "Sterling", "Unique", "Supreme", "Royal", "Classic", "Prime", "Modern", "Hindustan", "National", "Western",
    "Eastern", "Southern", "Indo", "Pioneer", "Alpha", "Vega", "Matrix", "Nova", "Orion", "Titan", "Aster", "Crest",
    "Summit", "Elite", "Fusion", "Galaxy", "Horizon", "Infinity", "Jupiter", "Kinetic", "Lotus", "Meridian",
    "Neptune", "Opal", "Pinnacle", "Quantum", "Radiant", "Sigma", "Trinity", "Unity", "Vector", "Ambika", "Balaji",
    "Chamunda", "Durga", "Ekdant", "Falcon", "Gurukrupa", "Hari Om", "Ishwar", "Jagdamba", "Kamdhenu", "Lokmanya",
    "Mangalam", "Nandi", "Padmavati", "Rajhans", "Saraswati", "Tirupati", "Umiya", "Vithal", "Yashoda", "Bhairav",
    "Chintamani", "Dhanlaxmi", "Gajraj", "Indrayani", "Jyotirling", "Kalpataru", "Mayur", "Nilkanth", "Panchganga",
    "Ratnagiri", "Shrinath", "Trimurti", "Vasundhara", "Amrut", "Bhagirathi", "Chaitanya", "Dnyaneshwar", "Girija",
    "Hanuman", "Indus", "Janaki", "Keshav", "Madhav", "Narayan", "Parvati", "Raghav", "Sanket", "Tanmay", "Uday",
    "Vinayak", "Yogeshwar", "Arihant", "Bhavani", "Chetak", "Dhruv", "Ganga", "Hemkunt", "Jivdani", "Kesari",
    "Mahavir", "Nirmiti", "Pushpak", "Rudra", "Shubham", "Tejas", "Utkarsh", "Vishwas", "Aakash", "Bhoomi",
    "Darshan", "Garuda", "Kailash", "Mrudgandh", "Nakshatra", "Prithvi", "Sankalp", "Swastik", "Varad", "Agastya",
    "Atharva", "Ishaan", "Kaustubh", "Mihir", "Ojas", "Pranav", "Saksham", "Vihaan", "Aarav", "Rishabh", "Samarth",
    "Shlok", "Tanish", "Advait", "Charvak", "Dakshin", "Eklavya", "Gandharv", "Hrishikesh", "Jayant", "Kartik",
    "Lakshya", "Manas", "Nikhil", "Omkareshwar", "Parth", "Ranveer", "Sarvesh", "Tushar", "Vedant", "Yuvraj",
]

CUSTOMER_CORES = {
    "auto": ["Auto Components", "Motors", "Auto Spares", "Transmission", "Automotive Systems", "Drivetrain"],
    "industrial": ["Engineering Works", "Industries", "Machines", "Pumps", "Valves", "Hydraulics", "Equipments",
                   "Automation", "Gears"],
    "aftermarket": ["Auto Traders", "Spares Centre", "Motor Stores", "Auto Agencies", "Parts Depot"],
}
VENDOR_CORES = ["Steels", "Alloys", "Castings", "Forgings", "Packaging", "Polymers", "Metal Works", "Tubes",
                "Fasteners", "Chemicals"]
SUFFIXES = ["Pvt Ltd", "Private Limited", "Ltd", "LLP", "& Co", "Enterprises"]

FIRST_NAMES = ["Amit", "Rohit", "Sachin", "Prakash", "Mahesh", "Suresh", "Nilesh", "Vinod", "Sanjay", "Ajay",
               "Deepak", "Manoj", "Rahul", "Kiran", "Swati", "Neha", "Pooja", "Asha", "Meena", "Kavita", "Sunil",
               "Ramesh", "Ganesh", "Yogesh", "Hemant", "Pravin", "Sameer", "Tushar", "Vaibhav", "Abhijit",
               "Shrikant", "Milind", "Dinesh", "Rajendra", "Arvind", "Harish", "Jitendra", "Kishor", "Lalit",
               "Mukund", "Nitin", "Omprakash", "Pankaj", "Ravindra", "Sudhir", "Uday", "Vijay", "Anand", "Bhushan"]
LAST_NAMES = ["Patil", "Joshi", "Kulkarni", "Deshmukh", "Pawar", "Jadhav", "Shinde", "Gaikwad", "Chavan", "More",
              "Bhosale", "Kale", "Sawant", "Naik", "Gokhale", "Bapat", "Agarwal", "Gupta", "Jain", "Patel", "Shah",
              "Reddy", "Rao", "Iyer", "Pillai", "Menon", "Nair", "Verma", "Singh", "Yadav", "Chopra", "Malhotra",
              "Bansal", "Goyal", "Mittal", "Saxena", "Trivedi", "Pandey", "Mishra", "Dubey", "Thakur", "Rane",
              "Wagh", "Salunkhe", "Kadam", "Mane", "Lokhande", "Phadke", "Ranade"]

# state code, city, distance from Bhosari (km), weight
PLACES = [
    ("27", "Pune", 20, 18), ("27", "Pimpri", 8, 10), ("27", "Chakan", 22, 8), ("27", "Mumbai", 160, 10),
    ("27", "Thane", 150, 5), ("27", "Nashik", 210, 6), ("27", "Aurangabad", 240, 6), ("27", "Kolhapur", 230, 4),
    ("27", "Nagpur", 720, 3), ("27", "Satara", 110, 3),
    ("24", "Ahmedabad", 660, 4), ("24", "Vadodara", 560, 3), ("24", "Rajkot", 870, 2),
    ("29", "Bengaluru", 840, 4), ("29", "Hubballi", 450, 2), ("33", "Chennai", 1180, 3), ("33", "Hosur", 880, 2),
    ("33", "Coimbatore", 1150, 1), ("06", "Gurugram", 1450, 2), ("06", "Faridabad", 1420, 1),
    ("09", "Noida", 1460, 1), ("36", "Hyderabad", 560, 3), ("23", "Indore", 590, 2), ("23", "Pithampur", 600, 1),
    ("07", "Delhi", 1440, 1),
]
AREAS = ["MIDC Bhosari", "MIDC Chakan", "Hadapsar Industrial Estate", "Kothrud", "Ambad MIDC", "Waluj MIDC",
         "Shiroli MIDC", "Butibori", "Andheri East", "Wagle Estate", "GIDC Vatva", "Makarpura GIDC", "Aji GIDC",
         "Peenya Industrial Area", "Gokul Road", "Ambattur Estate", "SIPCOT Phase II", "Udyog Vihar", "Sector 24",
         "Phase II Noida", "Balanagar", "Sanwer Road", "Sector 3 Pithampur", "Okhla Phase I", "Satara MIDC",
         "Bhosari Gaon", "Talawade", "Pimpri Colony", "Wakad", "Ranjangaon"]
PINCODES = {"Pune": "4110", "Pimpri": "4110", "Chakan": "4105", "Mumbai": "4000", "Thane": "4006", "Nashik": "4220",
            "Aurangabad": "4310", "Kolhapur": "4160", "Nagpur": "4400", "Satara": "4150", "Ahmedabad": "3800",
            "Vadodara": "3900", "Rajkot": "3600", "Bengaluru": "5600", "Hubballi": "5800", "Chennai": "6000",
            "Hosur": "6351", "Coimbatore": "6410", "Gurugram": "1220", "Faridabad": "1210", "Noida": "2013",
            "Hyderabad": "5000", "Indore": "4520", "Pithampur": "4547", "Delhi": "1100"}

BANKS = [("HDFC", "HDFC0000"), ("ICIC", "ICIC0000"), ("SBIN", "SBIN000"), ("UTIB", "UTIB0000"), ("KKBK", "KKBK0000"),
         ("BARB", "BARB0"), ("PUNB", "PUNB0"), ("MAHB", "MAHB000")]

TRANSPORTERS = ["VRL Logistics", "Gati Ltd", "TCI Freight", "Shree Maruti Courier", "Safexpress",
                "Deccan Roadlines", "Om Logistics", "Sahyadri Carriers"]
VEHICLE_SERIES = ["MH12", "MH14", "MH12", "MH14", "MH04", "MH15", "MH20", "MH09"]

# item code, description, rate in paise, business units it sells into
ITEMS = [
    ("BRK-DSC-220", "Brake disc 220 mm", 125000, ("auto", "aftermarket")),
    ("BRK-DRM-180", "Brake drum 180 mm", 98000, ("auto", "aftermarket")),
    ("CLT-PLT-200", "Clutch pressure plate", 215000, ("auto", "aftermarket")),
    ("GR-SPR-48T", "Spur gear 48T", 76000, ("industrial", "auto")),
    ("GR-HLC-32T", "Helical gear 32T", 132000, ("industrial",)),
    ("SFT-PRP-1200", "Propeller shaft 1200 mm", 485000, ("auto",)),
    ("FLY-WHL-310", "Flywheel 310 mm", 362000, ("auto", "aftermarket")),
    ("PMP-IMP-150", "Pump impeller 150 mm", 54000, ("industrial",)),
    ("VLV-BDY-50", "Valve body DN50", 268000, ("industrial",)),
    ("HYD-CYL-63", "Hydraulic cylinder 63 bore", 950000, ("industrial",)),
    ("BRG-HSG-205", "Bearing housing 205", 41000, ("industrial", "aftermarket")),
    ("KNK-STR-01", "Steering knuckle", 289000, ("auto",)),
    ("CRK-SFT-4C", "Crankshaft 4 cylinder", 875000, ("auto",)),
    ("MNF-EXH-01", "Exhaust manifold", 198000, ("auto", "aftermarket")),
    ("CPL-FLX-90", "Flexible coupling 90", 36000, ("industrial", "aftermarket")),
    ("BSH-SLV-40", "Bush sleeve 40 mm", 18000, ("industrial", "aftermarket", "auto")),
]

APPROVERS = ["R. Iyer (Sales Head)", "S. Nair (Regional Manager West)", "P. Kale (Regional Manager South)"]
CN_APPROVERS = ["R. Iyer (Sales Head)", "A. Kulkarni (CFO)"]
RECEIVERS = ["Stores In-charge", "Receiving Supervisor", "Gate Officer", "Warehouse Manager"]
